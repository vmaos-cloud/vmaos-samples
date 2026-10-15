package cloud.vmaos.samples;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import software.amazon.awssdk.auth.credentials.AwsSessionCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.retry.RetryPolicy;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import tools.jackson.databind.JsonNode;

final class S3Upload {
    static final int PART_BYTES = 8 * 1024 * 1024;
    private S3Upload() {}
    static void upload(FileChannel file, long size, String digest, JsonNode sts) throws Exception {
        try (S3Client s3 = S3Client.builder().endpointOverride(URI.create(sts.path("endpoint").asString()))
                .region(Region.of(sts.path("region").asString())).forcePathStyle(sts.path("forcePathStyle").asBoolean())
                .credentialsProvider(StaticCredentialsProvider.create(AwsSessionCredentials.create(sts.path("accessKeyId").asString(),
                        sts.path("secretAccessKey").asString(), sts.path("sessionToken").asString())))
                .httpClientBuilder(UrlConnectionHttpClient.builder().connectionTimeout(Duration.ofSeconds(10)).socketTimeout(Duration.ofSeconds(60)))
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .overrideConfiguration(c -> c.apiCallTimeout(Duration.ofSeconds(60)).retryPolicy(RetryPolicy.builder().numRetries(2).build()))
                .build()) {
            upload(s3, file, size, digest, sts, PART_BYTES);
        }
    }
    static void upload(S3Client s3, FileChannel file, long size, String digest, JsonNode sts, int partSize) throws Exception {
        if (partSize < 5 * 1024 * 1024 || (size + partSize - 1) / partSize > 10_000) throw new IllegalArgumentException("分片至少 5 MiB，最多 10000 片");
        String bucket = sts.path("bucket").asString(), key = sts.path("objectKey").asString(), uploadId = null;
        Instant expiration = Instant.parse(sts.path("expiration").asString());
        try {
            if (!Instant.now().isBefore(expiration)) throw new IllegalStateException("STS 已过期");
            uploadId = s3.createMultipartUpload(CreateMultipartUploadRequest.builder().bucket(bucket).key(key).build()).uploadId();
            if (uploadId == null || uploadId.isBlank()) throw new IllegalStateException("缺少 UploadId");
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            var parts = new ArrayList<CompletedPart>();
            for (long offset = 0; offset < size;) {
                if (!Instant.now().isBefore(expiration)) throw new IllegalStateException("STS 已过期");
                byte[] bytes = new byte[(int) Math.min(partSize, size - offset)]; ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) if (file.read(buffer) == -1) throw new IllegalStateException("文件大小发生变化");
                hash.update(bytes); int partNumber = parts.size() + 1;
                String etag = s3.uploadPart(UploadPartRequest.builder().bucket(bucket).key(key).uploadId(uploadId)
                        .partNumber(partNumber).contentLength((long) bytes.length).build(), RequestBody.fromBytes(bytes)).eTag();
                if (etag == null || etag.isBlank()) throw new IllegalStateException("分片响应缺少 ETag");
                parts.add(CompletedPart.builder().partNumber(partNumber).eTag(etag).build());
                offset += bytes.length; System.out.printf("S3 分片 %d：%d/%d 字节%n", partNumber, offset, size);
            }
            if (file.size() != size || !HexFormat.of().formatHex(hash.digest()).equals(digest)) throw new IllegalStateException("上传期间文件内容发生变化");
            s3.completeMultipartUpload(CompleteMultipartUploadRequest.builder().bucket(bucket).key(key).uploadId(uploadId)
                    .multipartUpload(CompletedMultipartUpload.builder().parts(parts).build()).build());
        } catch (Exception failure) {
            boolean cleanupFailed = false;
            if (uploadId != null) try { s3.abortMultipartUpload(AbortMultipartUploadRequest.builder().bucket(bucket).key(key).uploadId(uploadId).build()); }
            catch (Exception ignored) { cleanupFailed = true; }
            // SDK errors may contain request metadata. Keep credentials and raw SDK errors out of logs.
            throw new IllegalStateException("S3 分片上传失败，请检查网络、源文件和 STS 有效期" + (cleanupFailed ? "；中止分片未确认，请检查上传状态" : ""));
        }
    }
}
