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
                $body = @file_get_contents($path);
                if ($body === false) {
                    return null;
                }
                return ['body' => $body, 'contentType' => self::guessContentTypeFromPath($path)];
            }

            // Prefer curl when available — better timeout semantics and
            // easier header inspection.
            if (function_exists('curl_init')) {
                $handle = curl_init();
                if ($handle === false) {
                    return null;
                }
                curl_setopt_array($handle, [
                    CURLOPT_URL            => $url,
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_MAXREDIRS      => 5,
                    CURLOPT_CONNECTTIMEOUT => 5,
                    CURLOPT_TIMEOUT        => 10,
                    CURLOPT_SSL_VERIFYPEER => true,
                    CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_HTTPHEADER     => ['Accept: application/json, application/did+json, application/x-pem-file, */*'],
                ]);
                $body = curl_exec($handle);
                $code = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
                $type = (string) curl_getinfo($handle, CURLINFO_CONTENT_TYPE);
                curl_close($handle);

                if ($body === false || $code < 200 || $code >= 300) {
                    return null;
                }
                return ['body' => (string) $body, 'contentType' => $type];
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
            $body = @file_get_contents($url, false, $context);
            if ($body === false) {
                return null;
            }

            $contentType = '';
            // $http_response_header is populated by file_get_contents.
            if (isset($http_response_header) && is_array($http_response_header)) {
                foreach ($http_response_header as $h) {
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
}
