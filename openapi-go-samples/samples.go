package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

type STS struct {
	Endpoint        string    `json:"endpoint"`
	Region          string    `json:"region"`
	ForcePathStyle  bool      `json:"forcePathStyle"`
	Bucket          string    `json:"bucket"`
	ObjectKey       string    `json:"objectKey"`
	AccessKeyID     string    `json:"accessKeyId"`
	SecretAccessKey string    `json:"secretAccessKey"`
	SessionToken    string    `json:"sessionToken"`
	Expiration      time.Time `json:"expiration"`
}
type Grant struct {
	FileTID string `json:"fileTid"`
	Status  int    `json:"status"`
	STS     *STS   `json:"sts"`
}
type Probe struct {
	FileTID string `json:"fileTid"`
	Status  int    `json:"status"`
	Stage   string `json:"stage"`
	Next    int    `json:"nextProbeAfterSeconds"`
}

func queryBoards(ctx context.Context, api API, out io.Writer) error {
	var cursor json.RawMessage = []byte("null")
	for {
		raw, err := api.Post(ctx, boardsPath, map[string]any{"scroller": map[string]any{"cursor": cursor, "size": 200}})
		if err != nil {
			return err
		}
		var page struct {
			HasMore bool            `json:"hasMore"`
			Next    json.RawMessage `json:"nextCursor"`
		}
		if err = json.Unmarshal(raw, &page); err != nil {
			return errors.New("无效板卡响应")
		}
		fmt.Fprintln(out, string(raw))
		if !page.HasMore {
			return nil
		}
		var next struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(page.Next, &next) != nil || next.ID == "" || string(page.Next) == string(cursor) {
			return errors.New("无效 nextCursor")
		}
		cursor = page.Next // Entire cursor object, with string IDs, is passed unchanged.
	}
}
func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func probeFile(ctx context.Context, api API, id string, budget time.Duration, pause func(context.Context, time.Duration) error) (Probe, error) {
	if !regexp.MustCompile(`^[1-9][0-9]*$`).MatchString(id) {
		return Probe{}, errors.New("fileTid 必须为正整数十进制字符串")
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	delay := 1500 * time.Millisecond
	for {
		if err := pause(ctx, delay); err != nil {
			return Probe{}, fmt.Errorf("探测等待结束，fileTid=%s；可稍后继续 probe，不会终止服务端上传", id)
		}
		raw, err := api.Post(ctx, probePath, map[string]any{"fileTid": id, "forceFailIfIncomplete": false})
		if err != nil {
			return Probe{}, err
		}
		var result Probe
		if json.Unmarshal(raw, &result) != nil {
			return Probe{}, errors.New("无效探测响应")
		}
		switch result.Status {
		case 1:
			return result, nil
		case 0:
		default:
			return Probe{}, fmt.Errorf("文件不可用：status=%d，stage=%s", result.Status, result.Stage)
		}
		delay = time.Duration(result.Next) * time.Second
		if delay <= 0 {
			delay = 2 * time.Second
		}
	}
}

type uploadFunc func(context.Context, *os.File, int64, string, STS) error

func uploadFile(ctx context.Context, api API, path, tenantPath, category string, upload uploadFunc) (Probe, error) {
	if !strings.HasPrefix(tenantPath, "/") || strings.HasSuffix(tenantPath, "/") {
		return Probe{}, errors.New("网盘路径必须为含文件名的绝对路径")
	}
	if !regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`).MatchString(category) {
		return Probe{}, errors.New("分类必须为编码，如 APK 或 OTHER")
	}
	file, err := os.Open(path)
	if err != nil {
		return Probe{}, errors.New("无法打开本地文件")
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return Probe{}, err
	}
	size := before.Size()
	if !before.Mode().IsRegular() || size < 1 || size > 32*1024*1024*1024 {
		return Probe{}, errors.New("请选择 1 字节至 32 GiB 的普通文件")
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return Probe{}, err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	after, err := file.Stat()
	if err != nil {
		return Probe{}, err
	}
	if after.Size() != size || !after.ModTime().Equal(before.ModTime()) {
		return Probe{}, errors.New("计算摘要期间文件发生变化")
	}
	raw, err := api.Post(ctx, stsPath, map[string]any{"tenantPath": tenantPath, "sha256": digest, "sizeBytes": size, "fileCategory": category, "createDirectories": true, "durationSeconds": 3600})
	if err != nil {
		return Probe{}, err
	}
	var grant Grant
	if json.Unmarshal(raw, &grant) != nil {
		return Probe{}, errors.New("无效 STS 响应")
	}
	if grant.Status == 1 {
		return Probe{FileTID: grant.FileTID, Status: 1, Stage: "AVAILABLE"}, nil
	}
	if grant.Status != 0 || grant.STS == nil {
		return Probe{}, errors.New("未取得上传 STS")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return Probe{}, err
	}
	if err = upload(ctx, file, size, digest, *grant.STS); err != nil {
		return Probe{}, err
	}
	return probeFile(ctx, api, grant.FileTID, 5*time.Minute, sleep)
}
