import { PutObjectCommand } from "@aws-sdk/client-s3";

class S3Uploader {
  private static instance: S3Uploader;

  private constructor() {}

  public static getInstance(): S3Uploader {
    if (!S3Uploader.instance) {
      S3Uploader.instance = new S3Uploader();
    }
    return S3Uploader.instance;
  }

  public uploadFile(filename: string) {
    const command = new PutObjectCommand({
      Bucket: "peeple",
      Key: `uploads/${filename}`,
      ContentType: "image/jpeg",
      ACL: "public-read",
    });
    return command;
  }
}

export const s3Uploader = S3Uploader.getInstance();
