package cloud.vmaos.samples;

import static org.junit.jupiter.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Proxy;
import java.net.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import tools.jackson.databind.JsonNode;

class SamplesTest {
    @TempDir Path directory;
    static final String AK = "AK7WyN4fQp9_z3Hk2mLs8DxA";
    static final String SK = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    static JsonNode json(String s) throws Exception { return OpenApi.JSON.readTree(s); }
    static JsonNode sts() throws Exception { return json("""
            {"endpoint":"https://s3.example.com","region":"us-east-1","forcePathStyle":true,
             "bucket":"fixture-bucket","objectKey":"fixture-key","accessKeyId":"fixture-access",
             "secretAccessKey":"fixture-secret","sessionToken":"fixture-token","expiration":"2099-01-01T00:00:00Z"}
            """); }
    @Test void signatureMatchesInteroperabilityVector() throws Exception {
        assertEquals("630cb70b8a822c78ab4c7b4e2207f09cbd942485e2a70f365e69459d434f46c3", OpenApi.signature(
                URI.create("https://api.vmaos.example/openapi/v1/containers/query?page=1"), "{\"status\":1}".getBytes(StandardCharsets.UTF_8), AK, SK, "1789893015123"));
        assertThrows(IllegalArgumentException.class, () -> OpenApi.signature(URI.create("https://example.com"), new byte[0], AK, SK + "=", "1"));
    }
    @Test void queryOrderingAndDefaultHostPortAreCanonical() throws Exception {
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        assertEquals(OpenApi.signature(URI.create("https://example.com/path?x=b&x=a&space=a+b"), body, AK, SK, "1"),
                OpenApi.signature(URI.create("https://example.com:443/path?space=a%20b&x=a&x=b"), body, AK, SK, "1"));
    }
    @Test void environmentOverridesFileWithoutShellEvaluation() throws Exception {
        Path env = directory.resolve(".env"); Files.writeString(env, "# example\nVMAOS_ACCESS_KEY='file-value'\nVMAOS_SECRET_KEY=$(not-executed)\n");
        var values = OpenApi.loadEnvironment(env, Map.of("VMAOS_ACCESS_KEY", "environment-value"));
        assertEquals("environment-value", values.get("VMAOS_ACCESS_KEY")); assertEquals("$(not-executed)", values.get("VMAOS_SECRET_KEY"));
    }
    @Test void logsRedactNestedFieldsWithoutChangingOriginalCredentials() throws Exception {
        var original = json("{\"sts\":{\"secretAccessKey\":\"hidden\"},\"items\":[{\"session_token\":\"hidden\"}],\"fileTid\":\"123\"}");
        var safe = OpenApi.redact(original);
        assertFalse(safe.toString().contains("hidden")); assertEquals("hidden", original.at("/sts/secretAccessKey").asString());
        assertEquals("123", safe.path("fileTid").asString());
    }
    @Test void httpClientSignsSentBytesAndLogsSafeEnvelope() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var requests = new ArrayList<String>(); var logs = new ArrayList<String>();
        server.createContext(Samples.STS, exchange -> {
            try {
                byte[] bytes = exchange.getRequestBody().readAllBytes(); requests.add(new String(bytes, StandardCharsets.UTF_8));
                URI url = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + Samples.STS);
                String expected = OpenApi.signature(url, bytes, AK, SK, exchange.getRequestHeaders().getFirst("X-VMAOS-Timestamp"));
                if (!expected.equals(exchange.getRequestHeaders().getFirst("X-VMAOS-Signature"))) { exchange.sendResponseHeaders(401, -1); return; }
                byte[] response = ("{\"code\":200000000,\"message\":\"success\",\"traceId\":\"demo-trace\",\"data\":{\"status\":0,\"sts\":" + sts() + "}}").getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, response.length); exchange.getResponseBody().write(response);
            } catch (Exception failure) { throw new RuntimeException(failure); } finally { exchange.close(); }
        });
        server.start();
        try {
            OpenApi api = new OpenApi("http://127.0.0.1:" + server.getAddress().getPort(), AK, SK, logs::add);
            var result = api.post(Samples.STS, Map.of("tenantPath", "/应用/demo.xapk"));
            assertTrue(requests.get(0).contains("/应用/demo.xapk")); assertEquals("fixture-secret", result.at("/sts/secretAccessKey").asString());
            String text = String.join("\n", logs);
            for (String secret : List.of(AK, SK, "fixture-access", "fixture-secret", "fixture-token")) assertFalse(text.contains(secret));
            assertTrue(text.contains("demo-trace")); assertTrue(text.contains("200000000"));
        } finally { server.stop(0); }
    }
    @Test void boardsReuseEntireCursorAsString() throws Exception {
        var calls = new ArrayList<JsonNode>();
        Samples.boards((path, body) -> {
            calls.add(OpenApi.JSON.valueToTree(body));
            return calls.size() == 1 ? json("{\"items\":[],\"hasMore\":true,\"nextCursor\":{\"id\":\"9007199254740993\"}}") : json("{\"items\":[],\"hasMore\":false,\"nextCursor\":null}");
        });
        assertEquals("9007199254740993", calls.get(1).at("/scroller/cursor/id").asString());
    }
    static final class MutableClock extends Clock {
        Instant time = Instant.EPOCH;
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return time; }
    }
    @Test void probeWaitsAndKeepsForceFailFalse() throws Exception {
        var clock = new MutableClock(); var delays = new ArrayList<Long>(); var count = new AtomicInteger();
        JsonNode result = Samples.probe((path, body) -> {
            assertFalse(OpenApi.JSON.valueToTree(body).path("forceFailIfIncomplete").asBoolean());
            return count.incrementAndGet() == 1 ? json("{\"status\":0,\"nextProbeAfterSeconds\":3}") : json("{\"status\":1}");
        }, "123", Duration.ofSeconds(10), ms -> { delays.add(ms); clock.time = clock.time.plusMillis(ms); }, clock);
        assertEquals(1, result.path("status").asInt()); assertEquals(List.of(1500L, 3000L), delays);
    }
    @Test void probeRejectsTerminalStatesAndTimesOutLocally() throws Exception {
        for (int status : List.of(-1, -2, 2)) {
            var clock = new MutableClock();
            assertThrows(IllegalStateException.class, () -> Samples.probe((path, body) -> json("{\"status\":" + status + "}"),
                    "123", Duration.ofSeconds(5), ms -> clock.time = clock.time.plusMillis(ms), clock));
        }
        var clock = new MutableClock();
        assertThrows(IllegalStateException.class, () -> Samples.probe((path, body) -> json("{\"status\":0}"),
                "123", Duration.ofSeconds(2), ms -> clock.time = clock.time.plusMillis(ms), clock));
    }
    @Test void uploadHashesFileAndDeduplicationSkipsS3() throws Exception {
        Path path = directory.resolve("demo.bin"); Files.writeString(path, "abc");
        JsonNode result = Samples.upload((endpoint, body) -> {
            JsonNode request = OpenApi.JSON.valueToTree(body);
            assertEquals(Samples.STS, endpoint); assertEquals(OpenApi.sha256("abc".getBytes(StandardCharsets.UTF_8)), request.path("sha256").asString());
            assertEquals(3, request.path("sizeBytes").asInt()); return json("{\"fileTid\":\"123\",\"status\":1,\"sts\":null}");
        }, path, "/demo.bin", "OTHER", (file, size, digest, credentials) -> fail("S3 must be skipped"));
        assertEquals(1, result.path("status").asInt());
    }
    @Test void uploadWaitsForProbeAfterS3() throws Exception {
        Path path = directory.resolve("demo.bin"); Files.writeString(path, "abc"); var steps = new ArrayList<String>();
        JsonNode result = Samples.upload((endpoint, body) -> {
            if (endpoint.equals(Samples.STS)) { steps.add("sts"); return json("{\"fileTid\":\"123\",\"status\":0,\"sts\":" + sts() + "}"); }
            steps.add("probe"); return json("{\"fileTid\":\"123\",\"status\":1}");
        }, path, "/demo.bin", "OTHER", (file, size, digest, credentials) -> steps.add("s3"));
        assertEquals(List.of("sts", "s3", "probe"), steps); assertEquals(1, result.path("status").asInt());
    }
    @Test void multipartPreservesBytesAndETags() throws Exception { checkMultipart(false); }
    @Test void multipartFailureAbortsWithoutExposingSdkError() throws Exception { checkMultipart(true); }
    void checkMultipart(boolean failPart) throws Exception {
        byte[] bytes = new byte[5 * 1024 * 1024 + 3]; Arrays.fill(bytes, (byte) 7);
        Path path = directory.resolve("parts.bin"); Files.write(path, bytes);
        var calls = new ArrayList<String>(); var uploaded = new java.io.ByteArrayOutputStream();
        S3Client s3 = (S3Client) Proxy.newProxyInstance(S3Client.class.getClassLoader(), new Class<?>[]{S3Client.class}, (proxy, method, args) -> {
            calls.add(method.getName());
            switch (method.getName()) {
                case "createMultipartUpload": return CreateMultipartUploadResponse.builder().uploadId("demo-upload").build();
                case "uploadPart":
                    if (failPart) throw new IllegalStateException("hidden-sdk-credential");
                    UploadPartRequest part = (UploadPartRequest) args[0];
                    assertEquals("fixture-key", part.key());
                    uploaded.write(((RequestBody) args[1]).contentStreamProvider().newStream().readAllBytes());
                    return UploadPartResponse.builder().eTag("etag-" + part.partNumber()).build();
                case "completeMultipartUpload":
                    var parts = ((CompleteMultipartUploadRequest) args[0]).multipartUpload().parts();
                    assertEquals(List.of("etag-1", "etag-2"), parts.stream().map(CompletedPart::eTag).toList());
                    return CompleteMultipartUploadResponse.builder().build();
                case "abortMultipartUpload":
                    assertEquals("demo-upload", ((AbortMultipartUploadRequest) args[0]).uploadId());
                    return AbortMultipartUploadResponse.builder().build();
                default: throw new UnsupportedOperationException(method.getName());
            }
        });
        try (FileChannel file = FileChannel.open(path)) {
            if (failPart) {
                Exception error = assertThrows(IllegalStateException.class, () -> S3Upload.upload(s3, file, bytes.length, OpenApi.sha256(bytes), sts(), 5 * 1024 * 1024));
                assertFalse(error.getMessage().contains("hidden-sdk-credential"));
                assertEquals(List.of("createMultipartUpload", "uploadPart", "abortMultipartUpload"), calls);
            } else {
                S3Upload.upload(s3, file, bytes.length, OpenApi.sha256(bytes), sts(), 5 * 1024 * 1024);
                assertArrayEquals(bytes, uploaded.toByteArray());
                assertEquals(List.of("createMultipartUpload", "uploadPart", "uploadPart", "completeMultipartUpload"), calls);
            }
        }
    }
}
