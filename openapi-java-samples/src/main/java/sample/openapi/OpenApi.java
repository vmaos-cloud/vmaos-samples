package sample.openapi;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.function.Consumer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

/** Standalone customer example: only the three demonstrated POST endpoints are supported. */
public final class OpenApi implements Samples.Api {
    static final ObjectMapper JSON = new ObjectMapper();
    private final URI origin;
    private final String ak, sk;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private final Consumer<String> log;

    public OpenApi(String baseUrl, String ak, String sk, Consumer<String> log) {
        this.origin = URI.create(baseUrl);
        boolean local = Set.of("localhost", "127.0.0.1", "[::1]").contains(Objects.toString(origin.getHost(), ""));
        if (!("https".equals(origin.getScheme()) || ("http".equals(origin.getScheme()) && local))
                || origin.getHost() == null || origin.getUserInfo() != null || origin.getQuery() != null
                || origin.getFragment() != null || !(origin.getPath().isEmpty() || origin.getPath().equals("/"))) {
            throw new IllegalArgumentException("OPENAPI_BASE_URL 必须为 HTTPS origin（本机可用 HTTP）");
        }
        if (ak == null || ak.isBlank() || ak.chars().anyMatch(Character::isWhitespace) || sk == null) {
            throw new IllegalArgumentException("请配置 AK/SK");
        }
        this.ak = ak; this.sk = sk; this.log = log;
    }

    public static OpenApi fromEnvironment() throws Exception {
        var values = loadEnvironment(Path.of(".env"), System.getenv());
        for (String key : List.of("OPENAPI_BASE_URL", "OPENAPI_ACCESS_KEY", "OPENAPI_SECRET_KEY")) {
            if (!values.containsKey(key) || values.get(key).isBlank()) throw new IllegalArgumentException("缺少配置：" + key);
        }
        return new OpenApi(values.get("OPENAPI_BASE_URL"), values.get("OPENAPI_ACCESS_KEY"), values.get("OPENAPI_SECRET_KEY"), System.out::println);
    }

    // .env is data, never a shell script. Process environment overrides file values.
    static Map<String, String> loadEnvironment(Path file, Map<String, String> environment) throws Exception {
        var values = new HashMap<String, String>();
        if (Files.exists(file)) for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int separator = line.indexOf('=');
            if (separator < 1) throw new IllegalArgumentException(".env 格式应为 KEY=value");
            String key = line.substring(0, separator).trim(), value = line.substring(separator + 1).trim();
            if (value.length() >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
                value = value.substring(1, value.length() - 1);
            }
            values.put(key, value);
        }
        values.putAll(environment);
        return values;
    }

    static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static String encode(String text) {
        return URLEncoder.encode(text, StandardCharsets.UTF_8).replace("+", "%20").replace("*", "%2A").replace("%7E", "~");
    }
    static String signature(URI url, byte[] body, String ak, String sk, String timestamp) throws Exception {
        byte[] key = Base64.getUrlDecoder().decode(sk);
        try {
            if (key.length != 32 || !Base64.getUrlEncoder().withoutPadding().encodeToString(key).equals(sk)) {
                throw new IllegalArgumentException("SK 必须为 32 字节密钥的无填充 Base64URL 编码");
            }
            var pairs = new ArrayList<String[]>();
            if (url.getRawQuery() != null && !url.getRawQuery().isEmpty()) for (String pair : url.getRawQuery().split("&", -1)) {
                String[] parts = pair.split("=", 2);
                pairs.add(new String[]{encode(URLDecoder.decode(parts[0], StandardCharsets.UTF_8)),
                        encode(URLDecoder.decode(parts.length == 2 ? parts[1] : "", StandardCharsets.UTF_8))});
            }
            pairs.sort(Comparator.<String[], String>comparing(p -> p[0]).thenComparing(p -> p[1]));
            String query = String.join("&", pairs.stream().map(p -> p[0] + "=" + p[1]).toList());
            int port = url.getPort();
            boolean defaultPort = port == -1 || (port == 443 && url.getScheme().equals("https")) || (port == 80 && url.getScheme().equals("http"));
            String host = url.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
            String canonical = String.join("\n", "HMAC-SHA-256", ak, timestamp, "POST", url.getRawPath().isEmpty() ? "/" : url.getRawPath(),
                    query, host, "application/json", sha256(body));
            Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } finally { Arrays.fill(key, (byte) 0); }
    }

    static JsonNode redact(JsonNode source) {
        JsonNode copy = source.deepCopy();
        redactInPlace(copy); return copy;
    }
    private static void redactInPlace(JsonNode node) {
        if (node instanceof ObjectNode object) {
            for (String key : new ArrayList<>(object.propertyNames())) {
                String normalized = key.replace("-", "").replace("_", "").toLowerCase(Locale.ROOT);
                if (Set.of("ak", "sk", "accesskey", "accesskeyid", "accesskeysecret", "secretkey", "secretaccesskey", "sessiontoken", "token", "password", "secret", "signature", "authorization", "xapiaccesskey", "xapisignature").contains(normalized)) {
                    object.put(key, "[REDACTED]");
                } else redactInPlace(object.get(key));
            }
        } else if (node.isArray()) node.forEach(OpenApi::redactInPlace);
    }
    private void emit(Map<String, Object> entry) throws Exception {
        log.accept("[OpenAPI " + entry.get("event") + "] POST " + entry.get("path") + "\n"
                + JSON.writerWithDefaultPrettyPrinter().writeValueAsString(redact(JSON.valueToTree(entry))));
    }

    @Override public JsonNode post(String path, Object data) throws Exception { return post(path, data, Duration.ofSeconds(30)); }
    @Override public JsonNode post(String path, Object data, Duration timeout) throws Exception {
        if (!Set.of(Samples.BOARDS, Samples.STS, Samples.PROBE).contains(path)) throw new IllegalArgumentException("示例未支持此接口");
        URI url = origin.resolve(path);
        byte[] body = JSON.writeValueAsBytes(data); // These exact bytes are both hashed and sent.
        String timestamp = Long.toString(System.currentTimeMillis());
        HttpRequest request = HttpRequest.newBuilder(url).timeout(timeout).header("Content-Type", "application/json")
                .header("X-API-Algorithm", "HMAC-SHA-256").header("X-API-Access-Key", ak)
                .header("X-API-Timestamp", timestamp).header("X-API-Signature", signature(url, body, ak, sk, timestamp))
                .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
        emit(Map.of("event", "request", "method", "POST", "path", path, "body", JSON.readTree(body)));
        long started = System.nanoTime();
        HttpResponse<byte[]> response;
        try { response = http.send(request, HttpResponse.BodyHandlers.ofByteArray()); }
        catch (Exception failure) {
            emit(Map.of("event", "error", "method", "POST", "path", path, "errorType", failure.getClass().getSimpleName()));
            throw new IllegalStateException("OpenAPI 请求失败：" + failure.getClass().getSimpleName());
        }
        long elapsed = (System.nanoTime() - started) / 1_000_000;
        JsonNode envelope;
        try { envelope = JSON.readTree(response.body()); if (envelope == null) throw new IllegalArgumentException(); }
        catch (Exception failure) {
            emit(Map.of("event", "response", "method", "POST", "path", path, "httpStatus", response.statusCode(), "durationMs", elapsed, "body", "[非 JSON 响应，正文省略]"));
            throw new IllegalStateException("OpenAPI 返回非 JSON，HTTP " + response.statusCode());
        }
        emit(Map.of("event", "response", "method", "POST", "path", path, "httpStatus", response.statusCode(), "durationMs", elapsed, "body", envelope));
        if (response.statusCode() != 200 || envelope.path("code").asInt() != 200000000) {
            throw new IllegalStateException("OpenAPI HTTP " + response.statusCode() + "，code=" + envelope.path("code").asInt()
                    + "，traceId=" + envelope.path("traceId").asString("-"));
        }
        if (!envelope.hasNonNull("data")) throw new IllegalStateException("OpenAPI 成功响应缺少 data");
        return envelope.get("data");
    }
}
