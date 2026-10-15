package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type multipartAPI interface {
	CreateMultipartUpload(context.Context, *s3.CreateMultipartUploadInput, ...func(*s3.Options)) (*s3.CreateMultipartUploadOutput, error)
	UploadPart(context.Context, *s3.UploadPartInput, ...func(*s3.Options)) (*s3.UploadPartOutput, error)
	CompleteMultipartUpload(context.Context, *s3.CompleteMultipartUploadInput, ...func(*s3.Options)) (*s3.CompleteMultipartUploadOutput, error)
	AbortMultipartUpload(context.Context, *s3.AbortMultipartUploadInput, ...func(*s3.Options)) (*s3.AbortMultipartUploadOutput, error)
}

func uploadS3(ctx context.Context, file *os.File, size int64, digest string, sts STS) error {
	client := s3.New(s3.Options{Region: sts.Region, BaseEndpoint: aws.String(sts.Endpoint), UsePathStyle: sts.ForcePathStyle,
		Credentials: credentials.NewStaticCredentialsProvider(sts.AccessKeyID, sts.SecretAccessKey, sts.SessionToken),
		HTTPClient:  &http.Client{Timeout: 60 * time.Second}, RetryMaxAttempts: 3,
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired, ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired})
	return multipartUpload(ctx, client, file, size, digest, sts, 8*1024*1024)
}
func multipartUpload(ctx context.Context, client multipartAPI, file *os.File, size int64, digest string, sts STS, partSize int) (err error) {
	if partSize < 5*1024*1024 || (size+int64(partSize)-1)/int64(partSize) > 10000 {
		return errors.New("分片至少 5 MiB，最多 10000 片")
	}
	if !time.Now().Before(sts.Expiration) {
		return errors.New("STS 已过期")
	}
	bucket, key := aws.String(sts.Bucket), aws.String(sts.ObjectKey)
	created, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: bucket, Key: key})
	if err != nil {
		return errors.New("S3 创建分片失败，请检查网络和 STS")
	}
	if created.UploadId == nil || *created.UploadId == "" {
		return errors.New("S3 缺少 UploadId")
	}
	defer func() {
		if err == nil {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_, cleanupErr := client.AbortMultipartUpload(cleanupCtx, &s3.AbortMultipartUploadInput{Bucket: bucket, Key: key, UploadId: created.UploadId})
		if cleanupErr != nil {
			err = errors.New("S3 分片上传失败；中止分片未确认，请检查上传状态")
		} else {
			err = errors.New("S3 分片上传失败，请检查网络、源文件和 STS 有效期")
		}
	}()
	var parts []types.CompletedPart
	hash := sha256.New()
	for offset := int64(0); offset < size; {
		if !time.Now().Before(sts.Expiration) {
			return errors.New("STS 已过期")
		}
		n := int64(partSize)
		if size-offset < n {
			n = size - offset
		}
		body := make([]byte, int(n))
		if _, err = io.ReadFull(file, body); err != nil {
			return err
		}
		_, _ = hash.Write(body)
		number := int32(len(parts) + 1)
		result, e := client.UploadPart(ctx, &s3.UploadPartInput{Bucket: bucket, Key: key, UploadId: created.UploadId, PartNumber: aws.Int32(number), Body: bytes.NewReader(body), ContentLength: aws.Int64(n)})
		if e != nil {
			return e
		}
		if result.ETag == nil || *result.ETag == "" {
			return errors.New("分片响应缺少 ETag")
		}
		parts = append(parts, types.CompletedPart{PartNumber: aws.Int32(number), ETag: result.ETag})
		offset += n
		fmt.Printf("S3 分片 %d：%d/%d 字节\n", number, offset, size)
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != size || hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("上传期间文件发生变化")
	}
	_, err = client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: bucket, Key: key, UploadId: created.UploadId, MultipartUpload: &types.CompletedMultipartUpload{Parts: parts}})
	return err
}
