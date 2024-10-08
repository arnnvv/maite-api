import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

let dummyusers: { [key: string]: string } = {};

setInterval(() => {
	console.info("Clearing OTP memory");
	dummyusers = {};
}, 25920000);

app.use("*", cors());

app.post("/", async (c) => {
	const body = await c.req.json();
	console.log(body);
	return c.json(body, 200);
});

const port = 3000;

serve(
	{
		fetch: app.fetch,
		port: port,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	},
);
