<?php
/**
 * Default HTTP fetcher used by the built-in KeyResolver implementations.
 *
 * Resolvers accept any callable matching the signature
 *
 *     function (string $url): ?array { return ['body' => string, 'contentType' => string]; }
 *
 * which makes them trivially mockable in tests. This class supplies the
 * production callable, preferring curl when available and falling back to
 * a stream-context file_get_contents.
 *
 * @package HTMLTrust\Canonicalization\Keys
 */

namespace HTMLTrust\Canonicalization\Keys;

final class HttpFetcher
{
    private const MAX_RESPONSE_BYTES = 64 * 1024;

    /**
     * Validate a response returned by either the default or an injected
     * fetcher. Injection is useful for tests and alternate transports, but it
     * must retain the same response-size bound as the built-in transport.
     *
     * @param array{body: string, contentType?: string}|null $response
     * @return array{body: string, contentType?: string}|null
     */
    public static function validateResponse(?array $response): ?array
    {
        if ($response === null) {
            return null;
        }
        if (!isset($response['body']) || !is_string($response['body'])) {
            throw new \InvalidArgumentException('invalid response body');
        }
        if (strlen($response['body']) > self::MAX_RESPONSE_BYTES) {
            throw new \InvalidArgumentException('resource-limit-exceeded');
        }
        return $response;
    }

    /**
     * Returns a callable suitable for injection into a KeyResolver:
     *
     *     $fetcher = HttpFetcher::default();
     *     $resolver = new DidWebResolver($fetcher);
     *
     * The callable returns null on failure, or
     *   ['body' => string, 'contentType' => string]
     * on success.
     *
     * Accepts file:// URLs (useful for tests) by reading directly from disk.
     */
    public static function default(): callable
    {
        return static function (string $url): ?array {
            // Local file:// path — useful for tests and dev fixtures.
            if (strncmp($url, 'file://', 7) === 0) {
                $path = substr($url, 7);
                if (!is_readable($path)) {
                    return null;
                }
                $stream = @fopen($path, 'rb');
                if ($stream === false) {
                    return null;
                }
                $body = self::readLimitedStream($stream);
                fclose($stream);
                if ($body === null) return null;
                return ['body' => $body, 'contentType' => self::guessContentTypeFromPath($path)];
            }

            // Prefer curl when available — better timeout semantics and
            // easier header inspection.
            if (function_exists('curl_init')) {
                $handle = curl_init();
                if ($handle === false) {
                    return null;
                }
                $body = '';
                $bodyBytes = 0;
                $tooLarge = false;
                curl_setopt_array($handle, [
                    CURLOPT_URL            => $url,
                    CURLOPT_RETURNTRANSFER => false,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_MAXREDIRS      => 5,
                    CURLOPT_CONNECTTIMEOUT => 5,
                    CURLOPT_TIMEOUT        => 10,
                    CURLOPT_SSL_VERIFYPEER => true,
                    CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_HTTPHEADER     => ['Accept: application/json, application/did+json, application/x-pem-file, */*'],
                    CURLOPT_WRITEFUNCTION  => static function ($handle, string $chunk) use (&$body, &$bodyBytes, &$tooLarge): int {
                        $length = strlen($chunk);
                        if ($bodyBytes + $length > self::MAX_RESPONSE_BYTES) {
                            $tooLarge = true;
                            return 0;
                        }
                        $body .= $chunk;
                        $bodyBytes += $length;
                        return $length;
                    },
                ]);
                $ok = curl_exec($handle);
                $code = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
                $type = (string) curl_getinfo($handle, CURLINFO_CONTENT_TYPE);
                curl_close($handle);

                if ($tooLarge || $ok === false || $code < 200 || $code >= 300) {
                    return null;
                }
                return ['body' => $body, 'contentType' => $type];
            }

            // file_get_contents fallback.
            $context = stream_context_create([
                'http' => [
                    'timeout' => 10,
                    'header'  => "Accept: application/json, application/did+json, application/x-pem-file, */*\r\n",
                ],
                'ssl' => [
                    'verify_peer'      => true,
                    'verify_peer_name' => true,
                ],
            ]);
            $stream = @fopen($url, 'rb', false, $context);
            if ($stream === false) {
                return null;
            }
            $body = self::readLimitedStream($stream);
            fclose($stream);
            if ($body === null) return null;

            $contentType = '';
            $responseHeaders = http_get_last_response_headers();
            if (is_array($responseHeaders)) {
                foreach ($responseHeaders as $h) {
                    if (stripos($h, 'content-type:') === 0) {
                        $contentType = trim(substr($h, strlen('content-type:')));
                        break;
                    }
                }
            }
            return ['body' => $body, 'contentType' => $contentType];
        };
    }

    private static function guessContentTypeFromPath(string $path): string
    {
        $ext = strtolower((string) pathinfo($path, PATHINFO_EXTENSION));
        switch ($ext) {
            case 'json': return 'application/json';
            case 'pem':  return 'application/x-pem-file';
            default:     return '';
        }
    }

    /** Read a response incrementally, retaining at most the protocol limit. */
    private static function readLimitedStream($stream): ?string
    {
        $body = '';
        $bytes = 0;
        while (!feof($stream)) {
            $chunk = fread($stream, 8192);
            if ($chunk === false) return null;
            if ($chunk === '') {
                if (feof($stream)) break;
                return null;
            }
            $bytes += strlen($chunk);
            if ($bytes > self::MAX_RESPONSE_BYTES) return null;
            $body .= $chunk;
        }
        return $body;
    }
}
