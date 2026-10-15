package cloud.vmaos.samples;

import java.nio.file.Path;
import tools.jackson.databind.JsonNode;

public final class Main {
    public static void main(String[] args) {
        try {
            if (args.length == 0) throw new IllegalArgumentException("用法：boards | upload <本地文件> <网盘路径> [分类] | probe <fileTid>");
            OpenApi api = OpenApi.fromEnvironment();
            JsonNode result;
            switch (args[0]) {
                case "boards" -> { if (args.length != 1) throw new IllegalArgumentException("boards 不接受参数"); Samples.boards(api); return; }
                case "upload" -> {
                    if (args.length < 3 || args.length > 4) throw new IllegalArgumentException("upload <本地文件> <网盘路径> [分类，默认 OTHER]");
                    result = Samples.upload(api, Path.of(args[1]), args[2], args.length == 4 ? args[3] : "OTHER");
                }
                case "probe" -> {
                    if (args.length != 2) throw new IllegalArgumentException("probe <fileTid>");
                    result = Samples.probe(api, args[1]);
                }
                default -> throw new IllegalArgumentException("未知命令；可用 boards、upload、probe");
            }
            System.out.println("文件可用：fileTid=" + result.path("fileTid").asString());
        } catch (Exception failure) {
            System.err.println(failure instanceof IllegalArgumentException || failure instanceof IllegalStateException
                    ? failure.getMessage() : "操作失败：" + failure.getClass().getSimpleName());
            System.exit(1);
        }
    }
}
