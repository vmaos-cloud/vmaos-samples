package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const boardsPath = "/open-api/board/query"
const stsPath = "/open-api/storage/upload-sts"
const probePath = "/open-api/storage/upload-probe"

type API interface {
	Post(context.Context, string, any) (json.RawMessage, error)
}
type Client struct {
	Origin *url.URL
	AK, SK string
	HTTP   *http.Client
	Log    func(any)
}
type Envelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	TraceID string          `json:"traceId"`
	Data    json.RawMessage `json:"data"`
}

// .env is parsed as literal data; process environment takes precedence.
func loadConfig(path string, lookup func(string) (string, bool)) (map[string]string, error) {
	values := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("无法读取 .env")
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, errors.New(".env 格式应为 KEY=value")
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		values[strings.TrimSpace(key)] = value
	}
	for _, key := range []string{"OPENAPI_BASE_URL", "OPENAPI_ACCESS_KEY", "OPENAPI_SECRET_KEY"} {
		if value, ok := lookup(key); ok {
			values[key] = value
		}
		if values[key] == "" {
			return nil, fmt.Errorf("缺少配置：%s", key)
		}
	}
	return values, nil
}
func newClient(base, ak, sk string, log func(any)) (*Client, error) {
	origin, err := url.Parse(base)
	if err != nil {
		return nil, errors.New("无效 OpenAPI 地址")
	}
	local := origin.Hostname() == "127.0.0.1" || origin.Hostname() == "localhost" || origin.Hostname() == "::1"
	if (origin.Scheme != "https" && !(origin.Scheme == "http" && local)) || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return nil, errors.New("OPENAPI_BASE_URL 必须为 HTTPS origin（本机可用 HTTP）")
	}
	if ak == "" || strings.ContainsAny(ak, " \t\r\n") || sk == "" {
		return nil, errors.New("请配置 AK/SK")
	}
	return &Client{Origin: origin, AK: ak, SK: sk, Log: log, HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func encode(s string) string { return strings.ReplaceAll(url.QueryEscape(s), "+", "%20") }
func signature(u *url.URL, body []byte, ak, sk, timestamp string) (string, error) {
	key, err := base64.RawURLEncoding.DecodeString(sk)
	if err != nil || len(key) != 32 || base64.RawURLEncoding.EncodeToString(key) != sk {
		return "", errors.New("SK 必须为 32 字节密钥的无填充 Base64URL 编码")
	}
	defer clear(key)
	var pairs [][2]string
	for key, values := range u.Query() {
		for _, value := range values {
			pairs = append(pairs, [2]string{encode(key), encode(value)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i][0] == pairs[j][0] {
			return pairs[i][1] < pairs[j][1]
		}
		return pairs[i][0] < pairs[j][0]
	})
	query := make([]string, len(pairs))
	for i, pair := range pairs {
		query[i] = pair[0] + "=" + pair[1]
	}
	host := strings.ToLower(u.Host)
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		host = strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	payload := sha256.Sum256(body)
	canonical := strings.Join([]string{"HMAC-SHA-256", ak, timestamp, "POST", path, strings.Join(query, "&"), host, "application/json", hex.EncodeToString(payload[:])}, "\n")
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil)), nil
}
func redact(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, child := range v {
			normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(key))
			switch normalized {
			case "ak", "sk", "accesskey", "accesskeyid", "accesskeysecret", "secretkey", "secretaccesskey", "sessiontoken", "token", "password", "secret", "signature", "authorization", "xapiaccesskey", "xapisignature":
				out[key] = "[REDACTED]"
			default:
				out[key] = redact(child)
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			out[i] = redact(child)
		}
		return out
	default:
		return value
	}
}
func (c *Client) emit(entry map[string]any) {
	if c.Log == nil {
		return
	}
	raw, _ := json.Marshal(entry)
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	_ = decoder.Decode(&value)
	c.Log(redact(value))
}
func (c *Client) Post(ctx context.Context, path string, data any) (json.RawMessage, error) {
	if path != boardsPath && path != stsPath && path != probePath {
		return nil, errors.New("示例未支持此接口")
	}
	u := c.Origin.ResolveReference(&url.URL{Path: path})
	body, err := json.Marshal(data)
	if err != nil {
		return nil, errors.New("无法编码 JSON 入参")
	}
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	signed, err := signature(u, body, c.AK, c.SK, timestamp)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("无法创建请求")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-API-Algorithm", "HMAC-SHA-256")
	request.Header.Set("X-API-Access-Key", c.AK)
	request.Header.Set("X-API-Timestamp", timestamp)
	request.Header.Set("X-API-Signature", signed)
	c.emit(map[string]any{"event": "request", "method": "POST", "path": path, "body": json.RawMessage(body)})
	started := time.Now()
	response, err := c.HTTP.Do(request)
	if err != nil {
		c.emit(map[string]any{"event": "error", "method": "POST", "path": path, "durationMs": time.Since(started).Milliseconds(), "errorType": fmt.Sprintf("%T", err)})
		return nil, errors.New("OpenAPI 请求失败，请检查网络或超时")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
	if err != nil {
		return nil, errors.New("读取 OpenAPI 响应失败")
	}
	if len(raw) > 8*1024*1024 {
		return nil, errors.New("OpenAPI 响应超过示例的 8 MiB 限制")
	}
	var envelope Envelope
	if json.Unmarshal(raw, &envelope) != nil {
		c.emit(map[string]any{"event": "response", "method": "POST", "path": path, "httpStatus": response.StatusCode, "body": "[非 JSON 响应，正文省略]"})
		return nil, fmt.Errorf("OpenAPI 返回非 JSON，HTTP %d", response.StatusCode)
	}
	c.emit(map[string]any{"event": "response", "method": "POST", "path": path, "httpStatus": response.StatusCode, "durationMs": time.Since(started).Milliseconds(), "body": json.RawMessage(raw)})
	if response.StatusCode != 200 || envelope.Code != 200000000 {
		return nil, fmt.Errorf("OpenAPI HTTP %d，code=%d，traceId=%s", response.StatusCode, envelope.Code, envelope.TraceID)
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return nil, errors.New("OpenAPI 成功响应缺少 data")
	}
	return envelope.Data, nil
}
