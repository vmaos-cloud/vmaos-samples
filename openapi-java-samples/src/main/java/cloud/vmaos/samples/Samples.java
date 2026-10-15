package cloud.vmaos.samples;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import tools.jackson.databind.JsonNode;

public final class Samples {
    public static final String BOARDS = "/open-api/board/query", STS = "/open-api/storage/upload-sts", PROBE = "/open-api/storage/upload-probe";
    @FunctionalInterface public interface Api {
        JsonNode post(String path, Object body) throws Exception;
        default JsonNode post(String path, Object body, Duration timeout) throws Exception { return post(path, body); }
    }
    @FunctionalInterface interface Sleeper { void sleep(long milliseconds) throws Exception; }
    @FunctionalInterface interface Uploader { void upload(FileChannel file, long size, String digest, JsonNode sts) throws Exception; }
    private Samples() {}

    public static void boards(Api api) throws Exception {
        JsonNode cursor = null;
        while (true) {
            var scroller = new LinkedHashMap<String, Object>(); scroller.put("cursor", cursor); scroller.put("size", 200);
            JsonNode page = api.post(BOARDS, Map.of("scroller", scroller));
            System.out.println(OpenApi.JSON.writerWithDefaultPrettyPrinter().writeValueAsString(page));
            if (!page.path("hasMore").asBoolean()) return;
            JsonNode next = page.path("nextCursor");
            if (!next.hasNonNull("id") || next.equals(cursor)) throw new IllegalStateException("无效 nextCursor");
            cursor = next; // Keep the entire cursor object; IDs remain decimal strings.
        }
    }

    public static JsonNode probe(Api api, String fileTid) throws Exception {
        return probe(api, fileTid, Duration.ofMinutes(5), Thread::sleep, Clock.systemUTC());
    }
    static JsonNode probe(Api api, String fileTid, Duration budget, Sleeper sleeper, Clock clock) throws Exception {
        if (fileTid == null || !fileTid.matches("[1-9][0-9]*")) throw new IllegalArgumentException("fileTid 必须为正整数十进制字符串");
        Instant deadline = clock.instant().plus(budget); long delay = 1500;
        while (clock.instant().isBefore(deadline)) {
            sleeper.sleep(Math.min(delay, Math.max(0, Duration.between(clock.instant(), deadline).toMillis())));
            Duration remaining = Duration.between(clock.instant(), deadline);
            if (remaining.isZero() || remaining.isNegative()) break;
            JsonNode result = api.post(PROBE, Map.of("fileTid", fileTid, "forceFailIfIncomplete", false),
                    remaining.compareTo(Duration.ofSeconds(30)) > 0 ? Duration.ofSeconds(30) : remaining);
            int status = result.path("status").asInt(Integer.MIN_VALUE);
            if (status == 1) return result;
            if (status != 0) throw new IllegalStateException("文件不可用：status=" + status + "，stage=" + result.path("stage").asString());
            delay = Math.max(1000, result.path("nextProbeAfterSeconds").asLong(2) * 1000);
        }
        throw new IllegalStateException("探测等待超时，fileTid=" + fileTid + "；可稍后继续 probe，不会终止服务端上传");
    }

    public static JsonNode upload(Api api, Path path, String tenantPath, String category) throws Exception {
        return upload(api, path, tenantPath, category, S3Upload::upload);
    }
    static JsonNode upload(Api api, Path path, String tenantPath, String category, Uploader uploader) throws Exception {
        if (!tenantPath.startsWith("/") || tenantPath.endsWith("/")) throw new IllegalArgumentException("网盘路径必须为含文件名的绝对路径");
        if (!category.matches("[A-Z][A-Z0-9_]{0,63}")) throw new IllegalArgumentException("分类必须为编码，如 APK 或 OTHER");
        if (!Files.isRegularFile(path)) throw new IllegalArgumentException("请选择普通文件");
        try (FileChannel file = FileChannel.open(path, StandardOpenOption.READ)) {
            long size = file.size();
            if (size < 1 || size > 32L * 1024 * 1024 * 1024) throw new IllegalArgumentException("文件应为 1 字节至 32 GiB");
            var modified = Files.getLastModifiedTime(path);
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            ByteBuffer buffer = ByteBuffer.allocate(1024 * 1024);
            while (file.read(buffer) != -1) { buffer.flip(); sha.update(buffer); buffer.clear(); }
            String digest = HexFormat.of().formatHex(sha.digest());
            if (file.size() != size || !modified.equals(Files.getLastModifiedTime(path))) throw new IllegalStateException("计算摘要期间文件发生变化");
            JsonNode grant = api.post(STS, Map.of("tenantPath", tenantPath, "sha256", digest, "sizeBytes", size,
                    "fileCategory", category, "createDirectories", true, "durationSeconds", 3600));
            if (grant.path("status").asInt() == 1) return grant; // Deduplication: no S3 calls.
            if (grant.path("status").asInt() != 0 || !grant.hasNonNull("sts")) throw new IllegalStateException("未取得上传 STS");
            file.position(0); uploader.upload(file, size, digest, grant.get("sts"));
            return probe(api, grant.path("fileTid").asString());
        }
    }
}
