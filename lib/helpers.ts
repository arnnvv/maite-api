import { getJWTSECRET } from "../src/server";
import jwt from "jsonwebtoken";

export const getEmail = async (token: string): Promise<string | undefined> => {
	try {
		const decoded = jwt.verify(token, getJWTSECRET());
		console.log("in try");
		//@ts-expect-error: W T F
		return decoded.email as string;
	} catch (e) {
		console.error(e);
		throw new Error(`Error in verifying: ${e}`);
	}
};
