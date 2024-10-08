import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "../lib/db";
import { users } from "../lib/db/schema";
import { v4 } from "uuid";
import { eq } from "drizzle-orm";
import { inferAsyncReturnType } from "@trpc/server";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "./router";
import { createTransport, SentMessageInfo } from "nodemailer";

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
}, 25920000);

const logWithColor = (message: string, color: string) => {
	console.log(`${color}%s\x1b[0m`, message);
};

app.use("*", cors());
app.use(
	"/trpc/*",
	trpcServer({
		router: appRouter,
	}),
);

const createContext = () => null;

type Context = inferAsyncReturnType<typeof createContext>;

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
