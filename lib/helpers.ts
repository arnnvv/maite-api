import { getJWTSECRET } from "../src/server";
import jwt from "jsonwebtoken";

export const getEmail = async (
	token: string,
): Promise<{ email: string } | { error: string }> => {
	try {
		const decoded = jwt.verify(token, getJWTSECRET());
		console.log("in try");
		//@ts-expect-error: W T F
		const email = decoded.email as string;
		return { email: email };
	} catch (e) {
		console.error(e);
		return { error: `Error in Verifying Token: ${e}` };
	}
};
