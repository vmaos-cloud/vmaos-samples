package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const fixtureAK = "AK7WyN4fQp9_z3Hk2mLs8DxA"
const fixtureSK = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

func hashBytes(bytes []byte) string { sum := sha256.Sum256(bytes); return hex.EncodeToString(sum[:]) }
func TestSignatureVector(t *testing.T) {
	u, _ := url.Parse("https://openapi.sample.com/openapi/v1/containers/query?page=1")
	got, err := signature(u, []byte(`{"status":1}`), fixtureAK, fixtureSK, "1789893015123")
	if err != nil || got != "e55d0512e0508809e9b21ce7fab8f084590fc07240066cae65e2d9f3de0849cb" {
		t.Fatalf("signature mismatch: %v", err)
	}
	if _, err = signature(u, nil, fixtureAK, fixtureSK+"=", "1"); err == nil {
		t.Fatal("padded SK accepted")
	}
}
func TestCanonicalQueryAndDefaultPort(t *testing.T) {
	a, _ := url.Parse("https://example.com/path?x=b&x=a&space=a+b")
	b, _ := url.Parse("https://example.com:443/path?space=a%20b&x=a&x=b")
	first, _ := signature(a, []byte("{}"), fixtureAK, fixtureSK, "1")
	second, _ := signature(b, []byte("{}"), fixtureAK, fixtureSK, "1")
	if first != second {
		t.Fatal("canonical forms differ")
	}
}
func TestEnvIsLiteralAndProcessOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	_ = os.WriteFile(path, []byte("OPENAPI_BASE_URL=https://example.com\nOPENAPI_ACCESS_KEY='file-value'\nOPENAPI_SECRET_KEY=$(not-executed)\n"), 0600)
	cfg, err := loadConfig(path, func(k string) (string, bool) { return "env-value", k == "OPENAPI_ACCESS_KEY" })
	if err != nil || cfg["OPENAPI_ACCESS_KEY"] != "env-value" || cfg["OPENAPI_SECRET_KEY"] != "$(not-executed)" {
		t.Fatal("unexpected environment parsing", err)
	}
}
func TestHTTPExactSignatureAndSafeLogs(t *testing.T) {
	var logs []any
	var origin string
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		requestBody = string(raw)
		u, _ := url.Parse(origin + r.URL.Path)
		expected, _ := signature(u, raw, fixtureAK, fixtureSK, r.Header.Get("X-API-Timestamp"))
		if expected != r.Header.Get("X-API-Signature") {
			w.WriteHeader(401)
			return
		}
		_, _ = io.WriteString(w, `{"code":200000000,"traceId":"demo-trace","data":{"sts":{"accessKeyId":"hidden-access","secretAccessKey":"hidden-secret","sessionToken":"hidden-token"}}}`)
	}))
	defer server.Close()
	origin = server.URL
	client, err := newClient(origin, fixtureAK, fixtureSK, func(e any) { logs = append(logs, e) })
	if err != nil {
		t.Fatal(err)
	}
	raw, err := client.Post(context.Background(), stsPath, map[string]any{"tenantPath": "/应用/demo.xapk"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "hidden-secret") || !strings.Contains(requestBody, "/应用/demo.xapk") {
		t.Fatal("credentials or Unicode body changed")
	}
	text, _ := json.Marshal(logs)
	for _, secret := range []string{fixtureAK, fixtureSK, "hidden-access", "hidden-secret", "hidden-token"} {
		if strings.Contains(string(text), secret) {
			t.Fatal("credential leaked")
		}
	}
	if !strings.Contains(string(text), "demo-trace") || !strings.Contains(string(text), "200000000") {
		t.Fatal("response diagnostics missing")
	}
}
func TestClientRejectsUnsafeOrigins(t *testing.T) {
	for _, origin := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path"} {
		if _, err := newClient(origin, fixtureAK, fixtureSK, nil); err == nil {
			t.Fatal("unsafe origin accepted")
		}
	}
}
func TestErrorEnvelopeIsLoggedWithRecursiveRedaction(t *testing.T) {
	var logs []any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = io.WriteString(w, `{"code":500904001,"traceId":"demo-error","details":[{"session_token":"hidden-response"}]}`)
	}))
	defer server.Close()
	client, _ := newClient(server.URL, fixtureAK, fixtureSK, func(e any) { logs = append(logs, e) })
	_, err := client.Post(context.Background(), probePath, map[string]any{"fileTid": "123", "nested": []any{map[string]any{"SK": "hidden-request"}}})
	if err == nil || !strings.Contains(err.Error(), "demo-error") {
		t.Fatal("error diagnostics missing")
	}
	text, _ := json.Marshal(logs)
	if strings.Contains(string(text), "hidden-") {
		t.Fatal("recursive redaction failed")
	}
}

type fakeAPI func(context.Context, string, any) (json.RawMessage, error)

func (f fakeAPI) Post(ctx context.Context, path string, body any) (json.RawMessage, error) {
	return f(ctx, path, body)
}
func TestBoardPaginationRetainsCursor(t *testing.T) {
	calls := 0
	api := fakeAPI(func(ctx context.Context, path string, body any) (json.RawMessage, error) {
		calls++
		raw, _ := json.Marshal(body)
		if calls == 1 {
			return json.RawMessage(`{"items":[],"hasMore":true,"nextCursor":{"id":"9007199254740993"}}`), nil
		}
		if !strings.Contains(string(raw), `"cursor":{"id":"9007199254740993"}`) {
			t.Fatal("cursor changed")
		}
		return json.RawMessage(`{"items":[],"hasMore":false,"nextCursor":null}`), nil
	})
	if err := queryBoards(context.Background(), api, io.Discard); err != nil || calls != 2 {
		t.Fatal(err, calls)
	}
}
func TestProbeWaitsAndNeverForcesFailure(t *testing.T) {
	var delays []time.Duration
	calls := 0
	api := fakeAPI(func(ctx context.Context, path string, body any) (json.RawMessage, error) {
		calls++
		raw, _ := json.Marshal(body)
		if !strings.Contains(string(raw), `"forceFailIfIncomplete":false`) {
			t.Fatal("force-failure changed")
		}
		if calls == 1 {
			return json.RawMessage(`{"status":0,"nextProbeAfterSeconds":3}`), nil
		}
		return json.RawMessage(`{"fileTid":"123","status":1}`), nil
	})
	result, err := probeFile(context.Background(), api, "123", time.Minute, func(_ context.Context, d time.Duration) error { delays = append(delays, d); return nil })
	if err != nil || result.Status != 1 || !reflect.DeepEqual(delays, []time.Duration{1500 * time.Millisecond, 3 * time.Second}) {
		t.Fatal(err, delays)
	}
}
func TestProbeTerminalStates(t *testing.T) {
	for _, status := range []int{-1, -2, 2} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			api := fakeAPI(func(context.Context, string, any) (json.RawMessage, error) {
				return json.RawMessage(fmt.Sprintf(`{"status":%d}`, status)), nil
			})
			if _, err := probeFile(context.Background(), api, "123", time.Minute, func(context.Context, time.Duration) error { return nil }); err == nil {
				t.Fatal("terminal status accepted")
			}
		})
	}
}
func TestProbeLocalTimeoutDoesNotCallAPI(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	api := fakeAPI(func(context.Context, string, any) (json.RawMessage, error) {
		t.Fatal("unexpected API call")
		return nil, nil
	})
	if _, err := probeFile(ctx, api, "123", time.Minute, sleep); err == nil {
		t.Fatal("missing timeout")
	}
}
func writeFixture(t *testing.T, data []byte) *os.File {
	t.Helper()
	p := filepath.Join(t.TempDir(), "demo.bin")
	if err := os.WriteFile(p, data, 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f
}
func TestUploadHashAndDeduplication(t *testing.T) {
	f := writeFixture(t, []byte("abc"))
	api := fakeAPI(func(ctx context.Context, path string, body any) (json.RawMessage, error) {
		raw, _ := json.Marshal(body)
		if path != stsPath || !strings.Contains(string(raw), hashBytes([]byte("abc"))) {
			t.Fatal("incorrect STS request")
		}
		return json.RawMessage(`{"fileTid":"123","status":1,"sts":null}`), nil
	})
	result, err := uploadFile(context.Background(), api, f.Name(), "/demo.bin", "OTHER", func(context.Context, *os.File, int64, string, STS) error {
		t.Fatal("S3 called for deduplication")
		return nil
	})
	if err != nil || result.Status != 1 {
		t.Fatal(err)
	}
}
func TestUploadSTSPartProbeOrder(t *testing.T) {
	f := writeFixture(t, []byte("abc"))
	var steps []string
	api := fakeAPI(func(ctx context.Context, path string, body any) (json.RawMessage, error) {
		if path == stsPath {
			steps = append(steps, "sts")
			return json.RawMessage(`{"fileTid":"123","status":0,"sts":{"accessKeyId":"fixture-access"}}`), nil
		}
		steps = append(steps, "probe")
		return json.RawMessage(`{"fileTid":"123","status":1}`), nil
	})
	result, err := uploadFile(context.Background(), api, f.Name(), "/demo.bin", "OTHER", func(_ context.Context, _ *os.File, size int64, digest string, s STS) error {
		steps = append(steps, "s3")
		if size != 3 || digest != hashBytes([]byte("abc")) || s.AccessKeyID != "fixture-access" {
			t.Fatal("S3 metadata changed")
		}
		return nil
	})
	if err != nil || result.Status != 1 || !reflect.DeepEqual(steps, []string{"sts", "s3", "probe"}) {
		t.Fatal(err, steps)
	}
}

type fakeS3 struct {
	calls []string
	body  bytes.Buffer
	fail  bool
	parts []types.CompletedPart
}

func (f *fakeS3) CreateMultipartUpload(context.Context, *s3.CreateMultipartUploadInput, ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error) {
	f.calls = append(f.calls, "create")
	return &s3.CreateMultipartUploadOutput{UploadId: aws.String("fixture-upload")}, nil
}
func (f *fakeS3) UploadPart(_ context.Context, in *s3.UploadPartInput, _ ...func(*s3.Options)) (*s3.UploadPartOutput, error) {
	f.calls = append(f.calls, "part")
	if f.fail {
		return nil, errors.New("hidden-sdk-credential")
	}
	_, _ = io.Copy(&f.body, in.Body)
	return &s3.UploadPartOutput{ETag: aws.String(fmt.Sprintf("etag-%d", *in.PartNumber))}, nil
}
func (f *fakeS3) CompleteMultipartUpload(_ context.Context, in *s3.CompleteMultipartUploadInput, _ ...func(*s3.Options)) (*s3.CompleteMultipartUploadOutput, error) {
	f.calls = append(f.calls, "complete")
	f.parts = in.MultipartUpload.Parts
	return &s3.CompleteMultipartUploadOutput{}, nil
}
func (f *fakeS3) AbortMultipartUpload(_ context.Context, in *s3.AbortMultipartUploadInput, _ ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error) {
	f.calls = append(f.calls, "abort")
	if *in.UploadId != "fixture-upload" {
		return nil, errors.New("wrong upload")
	}
	return &s3.AbortMultipartUploadOutput{}, nil
}
func TestMultipartBytesAndOrderedETags(t *testing.T) {
	data := bytes.Repeat([]byte{7}, 5*1024*1024+3)
	file := writeFixture(t, data)
	client := &fakeS3{}
	err := multipartUpload(context.Background(), client, file, int64(len(data)), hashBytes(data), STS{Bucket: "fixture-bucket", ObjectKey: "fixture-key", Expiration: time.Now().Add(time.Hour)}, 5*1024*1024)
	if err != nil || !bytes.Equal(client.body.Bytes(), data) || !reflect.DeepEqual(client.calls, []string{"create", "part", "part", "complete"}) {
		t.Fatal(err, client.calls)
	}
	if len(client.parts) != 2 || *client.parts[0].ETag != "etag-1" || *client.parts[1].ETag != "etag-2" {
		t.Fatal("ETags changed")
	}
}
func TestMultipartFailureAbortsAndHidesSDKDetails(t *testing.T) {
	file := writeFixture(t, []byte("abc"))
	client := &fakeS3{fail: true}
	err := multipartUpload(context.Background(), client, file, 3, hashBytes([]byte("abc")), STS{Expiration: time.Now().Add(time.Hour)}, 5*1024*1024)
	if err == nil || strings.Contains(err.Error(), "hidden-sdk") || !reflect.DeepEqual(client.calls, []string{"create", "part", "abort"}) {
		t.Fatal(err, client.calls)
	}
}
