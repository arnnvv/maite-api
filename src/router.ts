import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const appRouter = t.router({
	hello: t.procedure
		.input(z.object({ name: z.string() }))
		.query(({ input }) => {
			return `Hello, ${input.name}!`;
		}),

	createUser: t.procedure
		.input(z.object({ email: z.string().email() }))
		.mutation(async ({ input }) => {
			return { message: `User with email ${input.email} created!` };
		}),
});

export type AppRouter = typeof appRouter;
