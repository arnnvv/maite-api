import { S3Client } from "@aws-sdk/client-s3";

class S3Instance {
	private static instance: S3Instance;
	private s3Client: S3Client;

	private constructor() {
		const { accessKeyId, secretAccessKey } = this.getS3Credentials();
		this.s3Client = new S3Client({
			region: "us-east-2",
			credentials: {
				accessKeyId,
				secretAccessKey,
			},
		});
	}

	public static getInstance(): S3Instance {
		if (!this.instance) this.instance = new S3Instance();
		return this.instance;
	}

	private getS3Credentials(): {
		accessKeyId: string;
		secretAccessKey: string;
	} {
		const keyId = process.env.AWS_ACCESS_KEY_ID;
		const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

		if (!keyId || keyId.length === 0) throw new Error("S3 keyId not defined");
		if (!secretKey || secretKey.length === 0)
			throw new Error("S3 secret not defined");

		return {
			accessKeyId: keyId,
			secretAccessKey: secretKey,
		};
	}

	public getS3Client(): S3Client {
		return this.s3Client;
	}
}

export const s3: S3Client = S3Instance.getInstance().getS3Client();
