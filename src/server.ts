import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "../lib/db";
import { pictures, users } from "../lib/db/schema";
import { v4 } from "uuid";
import { eq } from "drizzle-orm";
import { createTransport, SentMessageInfo } from "nodemailer";
import jwt from "jsonwebtoken";
import { getEmail, getReccomendations } from "../lib/helpers";
import { s3 } from "../lib/imageStore";
import { s3Uploader } from "../lib/s3Uploader";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const getJWTSECRET = (): string =>
	process.env.JWT_SECRET ??
	((): never => {
		logWithColor("JWT_SECRET is missing!", "\x1b[31m"); // Red
		throw new Error("PLZ Define JWT Secret");
	})();

const getGmail = (): string =>
	process.env.GMAIL ??
	((): never => {
		logWithColor("GMAIL is missing!", "\x1b[31m"); // Red
		throw new Error("Mail not defined");
	})();

const getGmailPass = (): string =>
	process.env.GMAIL_PASS ??
	((): never => {
		logWithColor("GMAIL_PASS is missing!", "\x1b[31m"); // Red
		throw new Error("PLZ GET GMAIL PASSWORD");
	})();

const app = new Hono();

let dummyusers: { [key: string]: string } = {};

setInterval(() => {
	console.info("Clearing OTP memory");
	dummyusers = {};
}, 3600000);

const logWithColor = (message: string, color: string) => {
	console.log(`${color}%s\x1b[0m`, message);
};

const verifyToken = async (c: any, next: any) => {
	const token = c.req.header("Authorization")?.split(" ")[1];
	if (!token) return c.json({ error: "No token provided" }, 401);

	try {
		const emailOrError = await getEmail(token);

		if ("error" in emailOrError)
			return c.json({ error: emailOrError.error }, 401);

		c.set("email", emailOrError.email);
		await next();
	} catch (error) {
		return c.json({ error: "Invalid token" }, 401);
	}
};

app.use("*", cors());

app.post("/", async (c) => {
	const body = await c.req.json();
	console.log(body);
	return c.json(body, 200);
});

app.post("/check-email", async (c) => {
	logWithColor("POST /check-email - Request received", "\x1b[36m"); // Cyan

	try {
		const { email } = await c.req.json();

		if (!email) {
			logWithColor("Email is required but missing", "\x1b[31m"); // Red
			return c.json({ error: "Email is required" }, 400);
		}

		logWithColor(`Checking if email exists: ${email}`, "\x1b[36m"); // Cyan

		const user = await db
			.select()
			.from(users)
			.where(eq(users.email, email))
			.limit(1);

		if (user.length > 0) {
			logWithColor(`User with email ${email} found`, "\x1b[32m"); // Green
			const nameExists = user[0].name;

			if (nameExists) {
				logWithColor(`User already has a name: ${nameExists}`, "\x1b[33m"); // Yellow
				return c.json({ exists: true });
			} else {
				logWithColor(`User has no name, allowing profile creation`, "\x1b[33m"); // Yellow
				return c.json({ exists: false });
			}
		} else {
			logWithColor(
				`No user with email ${email}, creating new user`,
				"\x1b[36m",
			); // Cyan
			await db.insert(users).values({
				id: v4(),
				email: email,
			});
			return c.json({ exists: false });
		}
	} catch (error) {
		logWithColor(`Error during email check: ${error}`, "\x1b[31m"); // Red
		return c.json({ error: "Internal server error" }, 500);
	}
});

// Send OTP
app.post("/send-otp", async (c) => {
	logWithColor("POST /send-otp - Request received", "\x1b[36m"); // Cyan
	const { email } = await c.req.json();

	if (!email) {
		logWithColor("Email is required but missing", "\x1b[31m"); // Red
		return c.json({ error: "Email is required" }, 400);
	}

	const userExists = await db
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	if (userExists.length <= 0) {
		return c.json({ error: "User dosen't Exist" }, 400);
	}

	const otp = Math.floor(100000 + Math.random() * 900000).toString();
	logWithColor(`Generated OTP for ${email}: ${otp}`, "\x1b[36m"); // Cyan
	dummyusers[email] = otp;

	const mailOptions = {
		from: getGmail(),
		to: email,
		subject: "Your OTP",
		text: `Your OTP is ${otp}`,
	};

	const transporter = createTransport({
		service: "gmail",
		auth: {
			user: getGmail(),
			pass: getGmailPass(),
		},
	});

	logWithColor(`Attempting to send OTP to ${email}`, "\x1b[33m"); // Yellow
	transporter.sendMail(
		mailOptions,
		(error: Error | null, info: SentMessageInfo): Response | undefined => {
			if (error) {
				logWithColor(`Error sending OTP to ${email}: ${error}`, "\x1b[31m"); // Red
				return c.json({ error: "Error sending OTP" }, 500);
			} else {
				logWithColor(`OTP sent to ${email}: ${info.response}`, "\x1b[32m"); // Green
				return c.json({ message: "OTP sent to email" }, 200);
			}
		},
	);
});

app.post("/verify-otp", async (c) => {
	logWithColor("POST /verify-otp - Request received", "\x1b[36m"); // Cyan
	const { email, otp } = await c.req.json();
	logWithColor(`Verifying OTP for ${email}`, "\x1b[33m"); // Yellow

	if (dummyusers[email] === otp) {
		logWithColor(`OTP verified for ${email}`, "\x1b[32m"); // Green
		const token = jwt.sign({ email }, getJWTSECRET(), { expiresIn: "30d" });
		logWithColor(`Token generated for ${email}: ${token}`, "\x1b[36m"); // Cyan
		return c.json({ token }, 200);
	} else {
		logWithColor(
			`Invalid OTP for ${email}. Provided OTP: ${otp}, Expected OTP: ${dummyusers[email]}`,
			"\x1b[31m", // Red
		);
		return c.json({ error: "Invalid OTP" }, 401);
	}
});

app.use("/api/*", verifyToken);

app.post("/api/get-user", async (c) => {
	logWithColor("POST /get-user-from-token - Request received", "\x1b[36m"); // Cyan

	//@ts-expect-error: W T F
	const email = c.get("email") as string;
	logWithColor(`Verified email from token: ${email}`, "\x1b[32m"); // Green
	try {
		const userr = await db.select().from(users).where(eq(users.email, email));
		const user = userr[0];
		logWithColor(`User retrieved: ${JSON.stringify(user)}`, "\x1b[32m"); // Green

		logWithColor("Fetching user images", "\x1b[33m"); // Yellow
		const imagess = await db
			.select()
			.from(pictures)
			.where(eq(pictures.email, email));

		const images = imagess.map(
			(i: { id: number; email: string; url: string }): string => i.url,
		);
		logWithColor(`Images retrieved: ${JSON.stringify(images)}`, "\x1b[32m"); // Green

		return c.json({ user, images });
	} catch (error) {
		logWithColor(`Error retrieving user data: ${error}`, "\x1b[31m"); // Red
		return c.json({ error: "Error retrieving user data" }, 500);
	}
});

app.post("/create-user", async (c) => {
	logWithColor("POST /create-user - Request received", "\x1b[36m"); // Cyan
	const { user } = await c.req.json();
	logWithColor(`Received user data: ${JSON.stringify(user)}`, "\x1b[33m"); // Yellow

	if (!user || !user.name) {
		logWithColor("User name or data is missing", "\x1b[31m"); // Red
		return c.json({ error: "Name and email are required" }, 400);
	}

	try {
		logWithColor(
			`Checking if user with email ${user.email} exists`,
			"\x1b[33m",
		); // Yellow
		const existingUser = await db
			.select()
			.from(users)
			.where(eq(users.email, user.email));

		if (existingUser.length <= 0) {
			logWithColor(`User with email ${user.email} does not exist`, "\x1b[31m"); // Red
			return c.json({ error: "User with this email doesn't exist" }, 404);
		}

		logWithColor(`Updating user details for ${user.email}`, "\x1b[33m"); // Yellow
		console.log(user.religion);
		await db
			.update(users)
			.set({
				name: user.name,
				location: user.location,
				gender: user.gender,
				relationshiptype: user.relationshiptype,
				height: user.height,
				religion: user.religion,
				occupationArea: user.occupationArea,
				occupationField: user.occupationField,
				drink: user.drink,
				smoke: user.smoke,
				bio: user.bio,
				date: user.date,
				month: user.month,
				year: user.year,
				instaId: user.instaId,
				phone: user.phone,
			})
			.where(eq(users.email, user.email));

		logWithColor(`User details updated for ${user.email}`, "\x1b[32m"); // Green
		return c.json({ created: true }, 201);
	} catch (error) {
		logWithColor(`Error creating/updating user: ${error}`, "\x1b[31m"); // Red
		return c.json({ error: "Internal server error" }, 500);
	}
});

app.post("/profile-images", async (c) => {
	const { email, url } = await c.req.json();
	console.log(`email ki behen ki chut ${email}`);
	console.log(
		"Received POST request for /profile-images with the following data:",
	);
	console.log(JSON.stringify(c.req.json(), null, 2));

	// Field validation logging
	if (!email || !url) {
		console.log("Missing fields in request body:");
		if (!email) console.log("Missing email");
		if (!url) console.log("Missing URL");

		return c.json({ error: "All fields are required" }, 400);
	}

	try {
		console.log("Inserting new image into the database...");

		// Insert new image record
		const newImage = await db.insert(pictures).values({
			email,
			url,
		});

		console.log("Image inserted successfully into the database");
		console.log("Inserted image details:");
		console.log(JSON.stringify(newImage, null, 2));
		console.log("Sent 201 response to client: Image uploaded successfully");
		// Send success response
		return c.json({ message: "Image uploaded successfully", newImage }, 201);
	} catch (error) {
		return c.json({ error: "Failed to upload image" }, 500);
	}
});

// POST route for uploading image to S3
app.post("/upload-image", async (c) => {
	const { filename } = await c.req.json();

	logWithColor(
		`🚀 Starting the upload process for image: "${filename}"`,
		"\x1b[34m",
	); // Blue

	try {
		logWithColor(
			`📦 Preparing to upload the image to S3 with filename: "${filename}"`,
			"\x1b[34m",
		); // Blue

		const command = s3Uploader.uploadFile(filename);

		logWithColor(
			`🔗 Generating a signed URL for the image upload...`,
			"\x1b[34m",
		); // Blue

		try {
			const uploadUrl = await getSignedUrl(s3, command);
			logWithColor(
				`✅ Successfully generated the upload URL for "${filename}":\n${uploadUrl}`,
				"\x1b[35m",
			); // Magenta

			return c.json(
				{ message: "Upload URL generated successfully", uploadUrl },
				200,
			);
		} catch (error: any) {
			logWithColor(
				`❌ Failed to generate upload URL for "${filename}". Error: ${error.message}`,
				"\x1b[31m",
			); // Red
			return c.json(
				{ error: "Error generating signed URL", details: error.message },
				500,
			);
		}
	} catch (error: any) {
		logWithColor(
			`❌ Something went wrong during the upload initiation for "${filename}". Error: ${error.message}`,
			"\x1b[31m",
		); // Red
		return c.json(
			{
				error: "Failed to initiate image upload",
				details: error.message,
			},
			500,
		);
	}
});

// POST route for generating image viewing URL
app.post("/generate-url", async (c) => {
	const { filename } = await c.req.json();

	logWithColor(
		`🔍 Received a request to generate a viewing URL for the image: "${filename}"`,
		"\x1b[36m",
	); // Cyan

	if (!filename) {
		logWithColor("❌ No filename was provided in the request.", "\x1b[31m"); // Red
		return c.json({ error: "Filename is required" }, 400);
	}

	try {
		const url = `https://peeple.s3.ap-south-1.amazonaws.com/uploads/${filename}`;
		return c.json({ filename, url });
	} catch (error: any) {
		logWithColor(
			`❌ Failed to generate viewing URL for "${filename}". Error: ${error.message}`,
			"\x1b[31m",
		); // Red
		return c.json({ error: "Failed to generate URL" }, 500);
	}
});

app.post("/api/get-recommendations", async (c) => {
	console.log("HEYYYYYY");
	//@ts-expect-error: W T F
	const email = c.get("email") as string;

	if (!email) return c.json({ error: "Email is required." });

	console.log(email, "is sent");
	try {
		const recommendations = await getReccomendations(email);
		console.log(recommendations);
		return c.json({ recommendations });
	} catch (e) {
		console.error("Error fetching recommendations:", e);
		return c.json({ error: "Failed to fetch recommendations." }, 500);
	}
});

const port: number = 3000;

serve(
	{
		fetch: app.fetch,
		port: port,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	},
);
