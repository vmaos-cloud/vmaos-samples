package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("用法：boards | upload <本地文件> <网盘路径> [分类] | probe <fileTid>")
	}
	cfg, err := loadConfig(".env", os.LookupEnv)
	if err != nil {
		return err
	}
	api, err := newClient(cfg["VMAOS_BASE_URL"], cfg["VMAOS_ACCESS_KEY"], cfg["VMAOS_SECRET_KEY"], func(entry any) { b, _ := json.MarshalIndent(entry, "", "  "); fmt.Printf("[OpenAPI]\n%s\n", b) })
	if err != nil {
		return err
	}
	var result Probe
	switch args[0] {
	case "boards":
		if len(args) != 1 {
			return errors.New("boards 不接受参数")
		}
		return queryBoards(ctx, api, os.Stdout)
	case "upload":
		if len(args) < 3 || len(args) > 4 {
			return errors.New("upload <本地文件> <网盘路径> [分类，默认 OTHER]")
		}
		category := "OTHER"
		if len(args) == 4 {
			category = args[3]
		}
		result, err = uploadFile(ctx, api, args[1], args[2], category, uploadS3)
	case "probe":
		if len(args) != 2 {
			return errors.New("probe <fileTid>")
		}
		result, err = probeFile(ctx, api, args[1], 5*time.Minute, sleep)
	default:
		return errors.New("未知命令；可用 boards、upload、probe")
	}
	if err != nil {
		return err
	}
	fmt.Printf("文件可用：fileTid=%s\n", result.FileTID)
	return nil
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
