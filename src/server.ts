import e, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { db } from "../lib/db";
import { likes, pictures, users } from "../lib/db/schema";
import { v4 } from "uuid";
import { and, eq, inArray } from "drizzle-orm";
import { createTransport, SentMessageInfo } from "nodemailer";
import jwt from "jsonwebtoken";
import { getEmail, getReccomendations } from "../lib/helpers";
import { s3 } from "../lib/imageStore";
import { s3Uploader } from "../lib/s3Uploader";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface AuthenticatedRequest extends Request {
	email?: string;
}

const logWithColor = (message: string, color: string) => {
	console.log(`${color}%s\x1b[0m`, message);
};

const throwError = (ms: string): never => {
	logWithColor(ms, "\x1b[31m");
	throw new Error(ms);
};

export const env: {
	JWT_SECRET: string;
	GMAIL: string;
	GMAIL_PASS: string;
	PORT: number;
} = {
	JWT_SECRET: process.env.JWT_SECRET || throwError("JWT_SECRET is missing!"),
	GMAIL: process.env.GMAIL || throwError("GMAIL is missing!"),
	GMAIL_PASS: process.env.GMAIL_PASS || throwError("GMAIL_PASS is missing!"),
	PORT: Number(process.env.PORT) || throwError("PORT is missing!"),
};

const app = e();

app.use(e.json());
app.use(
	cors({
		origin: "*",
	}),
);

let dummyusers: { [key: string]: string } = {};

setInterval(() => {
	console.info("Clearing OTP memory");
	dummyusers = {};
}, 3600000);

const verifyToken = async (
	req: AuthenticatedRequest,
	res: Response,
	next: NextFunction,
) => {
	console.log("In verifyToken");

	const authHeader = req.header("Authorization");
	if (!authHeader) {
		console.log("auth header dosen't exist");
		res.status(401).json({ error: "No Authorization header provided" });
		return;
	}
	console.log("Auth header exists", authHeader);

	const [bearer, token] = authHeader.split(" ");

	console.log(bearer);
	console.log(token);

	if (bearer !== "Bearer" || !token) {
		res.status(401).json({ error: "Invalid Authorization header format" });
		return;
	}

	console.log("Token exists", token);

	try {
		const emailOrError: { email: string } | { error: string } =
			await getEmail(token);

		if ("error" in emailOrError) {
			res.json({ error: emailOrError.error });
			return;
		}
		console.log("no Error");
		req.email = emailOrError.email;
		console.log(req.email);
		next();
	} catch (error) {
		res.status(401).json({ error: "Invalid token" });
	}
};

app.post("/", (req: AuthenticatedRequest, res: Response) => {
	const body = req.body;
	console.log(body);
	res.status(200).json(body);
});

app.post("/check-email", async (req: AuthenticatedRequest, res: Response) => {
	logWithColor("POST /check-email - Request received", "\x1b[36m"); // Cyan

	try {
		const { email } = req.body;

		if (!email) {
			logWithColor("Email is required but missing", "\x1b[31m"); // Red
			res.status(400).json({ error: "Email is required" });
			return;
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
				res.json({ exists: true });
			} else {
				logWithColor(`User has no name, allowing profile creation`, "\x1b[33m"); // Yellow
				res.json({ exists: false });
			}
			return;
		} else {
			logWithColor(
				`No user with email ${email}, creating new user`,
				"\x1b[36m",
			); // Cyan
			await db.insert(users).values({
				id: v4(),
				email: email,
			});
			res.json({ exists: false });
		}
	} catch (error) {
		logWithColor(`Error during email check: ${error}`, "\x1b[31m"); // Red
		res.status(500).json({ error: "Internal server error" });
	}
});

// Send OTP
app.post("/send-otp", async (req: AuthenticatedRequest, res: Response) => {
	logWithColor("POST /send-otp - Request received", "\x1b[36m"); // Cyan
	const { email } = req.body;

	if (!email) {
		logWithColor("Email is required but missing", "\x1b[31m"); // Red
		res.status(400).json({ error: "Email is required" });
		return;
	}

	const userExists = await db
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	if (userExists.length <= 0) {
		res.status(400).json({ error: "User dosen't Exist" });
		return;
	}

	const otp = Math.floor(100000 + Math.random() * 900000).toString();
	logWithColor(`Generated OTP for ${email}: ${otp}`, "\x1b[36m"); // Cyan
	dummyusers[email] = otp;

	const mailOptions = {
		from: env.GMAIL,
		to: email,
		subject: "Your OTP",
		text: `Your OTP is ${otp}`,
	};

	const transporter = createTransport({
		service: "gmail",
		auth: {
			user: env.GMAIL,
			pass: env.GMAIL_PASS,
		},
	});

	logWithColor(`Attempting to send OTP to ${email}`, "\x1b[33m"); // Yellow
	transporter.sendMail(
		mailOptions,
		(error: Error | null, info: SentMessageInfo): Response | undefined => {
			if (error) {
				logWithColor(`Error sending OTP to ${email}: ${error}`, "\x1b[31m"); // Red
				res.status(500).json({ error: "Error sending OTP" });
				return;
			} else {
				logWithColor(`OTP sent to ${email}: ${info.response}`, "\x1b[32m"); // Green
				res.status(400).json({ message: "OTP sent to email" });
				return;
			}
		},
	);
});

app.post("/verify-otp", (req: AuthenticatedRequest, res: Response) => {
	logWithColor("POST /verify-otp - Request received", "\x1b[36m"); // Cyan
	const { email, otp } = req.body;
	logWithColor(`Verifying OTP for ${email}`, "\x1b[33m"); // Yellow

	if (dummyusers[email] === otp) {
		logWithColor(`OTP verified for ${email}`, "\x1b[32m"); // Green
		const token = jwt.sign({ email }, env.JWT_SECRET, { expiresIn: "30d" });
		logWithColor(`Token generated for ${email}: ${token}`, "\x1b[36m"); // Cyan
		res.status(200).json({ token });
		return;
	} else {
		logWithColor(
			`Invalid OTP for ${email}. Provided OTP: ${otp}, Expected OTP: ${dummyusers[email]}`,
			"\x1b[31m", // Red
		);
		res.status(401).json({ error: "Invalid OTP" });
	}
});

app.use("/api", verifyToken);

app.post("/api/get-user", async (req: AuthenticatedRequest, res: Response) => {
	logWithColor("POST /get-user-from-token - Request received", "\x1b[36m"); // Cyan

	const email: string = req.email!;

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

		res.json({ user, images });
	} catch (error) {
		logWithColor(`Error retrieving user data: ${error}`, "\x1b[31m"); // Red
		res.status(500).json({ error: "Error retrieving user data" });
	}
});

app.post("/create-user", async (req: AuthenticatedRequest, res: Response) => {
	logWithColor("POST /create-user - Request received", "\x1b[36m"); // Cyan
	const { user } = req.body;
	logWithColor(`Received user data: ${JSON.stringify(user)}`, "\x1b[33m"); // Yellow

	if (!user || !user.name) {
		logWithColor("User name or data is missing", "\x1b[31m"); // Red
		res.status(400).json({ error: "Name and email are required" });
		return;
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
			res.status(404).json({ error: "User with this email doesn't exist" });
			return;
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
		res.status(201).json({ created: true });
	} catch (error) {
		logWithColor(`Error creating/updating user: ${error}`, "\x1b[31m"); // Red
		res.status(500).json({ error: "Internal server error" });
	}
});

app.post(
	"/profile-images",
	async (req: AuthenticatedRequest, res: Response) => {
		const { email, url } = req.body;
		console.log(`email ki behen ki chut ${email}`);
		console.log(
			"Received POST request for /profile-images with the following data:",
		);
		console.log(JSON.stringify(req.body, null, 2));

		// Field validation logging
		if (!email || !url) {
			console.log("Missing fields in request body:");
			if (!email) console.log("Missing email");
			if (!url) console.log("Missing URL");

			res.status(400).json({ error: "All fields are required" });
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
			res
				.status(201)
				.json({ message: "Image uploaded successfully", newImage });
		} catch (error) {
			res.status(500).json({ error: "Failed to upload image" });
		}
	},
);

// POST route for uploading image to S3
app.post("/upload-image", async (req: AuthenticatedRequest, res: Response) => {
	const { filename } = req.body;

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

			res
				.status(200)
				.json({ message: "Upload URL generated successfully", uploadUrl });
		} catch (error: any) {
			logWithColor(
				`❌ Failed to generate upload URL for "${filename}". Error: ${error.message}`,
				"\x1b[31m",
			); // Red
			res
				.status(500)
				.json({ error: "Error generating signed URL", details: error.message });
		}
	} catch (error: any) {
		logWithColor(
			`❌ Something went wrong during the upload initiation for "${filename}". Error: ${error.message}`,
			"\x1b[31m",
		); // Red
		res.status(500).json({
			error: "Failed to initiate image upload",
			details: error.message,
		});
	}
});

// POST route for generating image viewing URL
app.post("/generate-url", async (req: AuthenticatedRequest, res: Response) => {
	const { filename } = req.body;

	logWithColor(
		`🔍 Received a request to generate a viewing URL for the image: "${filename}"`,
		"\x1b[36m",
	); // Cyan

	if (!filename) {
		logWithColor("❌ No filename was provided in the request.", "\x1b[31m"); // Red
		res.status(400).json({ error: "Filename is required" });
	}

	try {
		const url = `https://peeple.s3.ap-south-1.amazonaws.com/uploads/${filename}`;
		res.json({ filename, url });
	} catch (error: any) {
		logWithColor(
			`❌ Failed to generate viewing URL for "${filename}". Error: ${error.message}`,
			"\x1b[31m",
		); // Red
		res.status(500).json({ error: "Failed to generate URL" });
	}
});

app.post(
	"/api/get-recommendations",
	async (req: AuthenticatedRequest, res: Response) => {
		console.log("HEYYYYYY");
		const email: string = req.email!;

		console.log(email, "is sent");
		try {
			const recommendations = await getReccomendations(email);
			console.log(recommendations);
			res.json({ recommendations });
		} catch (e) {
			console.error("Error fetching recommendations:", e);
			res.status(500).json({ error: "Failed to fetch recommendations." });
		}
	},
);

app.post("/api/checkPlan", async (req: AuthenticatedRequest, res: Response) => {
	console.log("bhaiya req ja rhi hai ");
	const email = req.email!;
	try {
		const user = await db.select().from(users).where(eq(users.email, email));
		if (user[0].subscription === "basic") {
			res.json({ hasBasicPlan: true });
		} else {
			res.json({ hasBasicPlan: false });
		}
	} catch (e) {
		throw new Error(`${e}`);
	}
});

app.post(
	"/api/updateUserPlan",
	async (req: AuthenticatedRequest, res: Response) => {
		const email = req.email!;

		const { plan } = req.body;

		const togglePlan = (currentPlan: string) => {
			return currentPlan === "basic" ? "premium" : "basic";
		};

		try {
			const newPlan = togglePlan(plan); // Toggle the plan
			await db
				.update(users)
				.set({
					subscription: newPlan,
				})
				.where(eq(users.email, email));
			res.json({ success: true });
		} catch (e: any) {
			res.status(500).json({ error: e.message });
		}
	},
);

app.post("/api/add-like", async (req: AuthenticatedRequest, res: Response) => {
	const likerEmail = req.email!;
	try {
		const { likedEmail } = req.body;

		// Check if both emails are provided
		if (!likedEmail)
			res.status(500).json({
				message: "Both likerEmail and likedEmail must be provided.",
			});

		const existingLike = await db
			.select()
			.from(likes)
			.where(
				and(eq(likes.likerEmail, likerEmail), eq(likes.likedEmail, likedEmail)),
			)
			.limit(1);

		if (existingLike.length > 0) {
			console.log("\x1b[33m[Info] Like already exists");
			return;
		}

		console.log(
			`\x1b[36m[Debug] Received likerEmail: ${likerEmail}, likedEmail: ${likedEmail}`,
		);

		// Insert into the 'likes' table
		await db.insert(likes).values({
			likerEmail,
			likedEmail,
		});

		console.log("\x1b[32m[Success] Like added successfully");

		// Respond with success
		res.status(201).json({
			message: "Like added successfully.",
			likerEmail,
			likedEmail,
		});
	} catch (error) {
		console.error("\x1b[31m[Error] Failed to add like:", error);
		res.status(500).json({
			message: "Failed to add like.",
			error: error,
		});
	}
});

app.post("/api/liked-by", async (req: AuthenticatedRequest, res: Response) => {
	const email = req.email!;
	try {
		console.log(`\x1b[36m[Debug] Fetching users who liked: ${email}`);

		// Query the likes table to find all users who liked this user
		const likedByUsers = await db
			.select({
				likerEmail: users.email,
				likerName: users.name,
			})
			.from(likes)
			.innerJoin(users, eq(likes.likerEmail, users.email)) // Correct usage of eq for inner join
			.where(eq(likes.likedEmail, email)); // Ensure to use eq for where condition

		console.log("\x1b[32m[Success] Users fetched successfully:", likedByUsers);

		// Respond with the list of users who liked this user
		res.status(200).json({
			message: "Users fetched successfully.",
			likedByUsers,
		});
	} catch (error: any) {
		console.error("\x1b[31m[Error] Failed to fetch users:", error);
		res.status(500).json({
			message: "Failed to fetch users.",
			error: error.message,
		});
	}
});

app.post(
	"/api/mutual-likes",
	async (req: AuthenticatedRequest, res: Response) => {
		const email = req.email!;
		try {
			console.log(`\x1b[36m[Debug] Fetching mutual likes for: ${email}`);

			const mutualLikes = await db
				.select({
					name: users.name,
					instaId: users.instaId,
					phone: users.phone,
					photoUrl: pictures.url,
				})
				.from(likes)
				.innerJoin(users, eq(likes.likedEmail, users.email))
				.innerJoin(pictures, eq(users.email, pictures.email))
				.where(
					and(
						eq(likes.likerEmail, email),
						inArray(
							likes.likedEmail,
							db
								.select({ likedEmail: likes.likerEmail })
								.from(likes)
								.where(eq(likes.likedEmail, email)),
						),
					),
				)
				.groupBy(
					users.name,
					users.instaId,
					users.phone,
					pictures.url,
					users.email,
				);

			const results = mutualLikes.map((row) => ({
				userName: row.name,
				instaId: row.instaId,
				phone: row.phone,
				photoUrl: row.photoUrl,
			}));
			console.log(
				"\x1b[32m[Success] Mutual likes fetched successfully:",
				results,
			);

			// Respond with the list of mutual likes along with user details
			res.status(200).json({
				message: "Mutual likes fetched successfully.",
				mutualLikes: results, // Responding with the extracted user details
			});
		} catch (error: any) {
			console.error("\x1b[31m[Error] Failed to fetch mutual likes:", error);
			res.status(500).json({
				message: "Failed to fetch mutual likes.",
				error: error.message,
			});
		}
	},
);

app.listen(env.PORT, () => {
	console.log(`Server listning on http://localhost:${env.PORT}`);
});
