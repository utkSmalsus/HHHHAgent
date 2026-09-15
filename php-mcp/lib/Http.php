<?php
declare(strict_types=1);

/** Thin cURL-based JSON HTTP helper — no dependency needed for plain REST calls. */
final class Http
{
    /**
     * @param int $timeoutSeconds confirmed live: 30s (the default) isn't enough for a full-payload
     *   scroll of a large type like "meeting" (real transcripts included) — investigate_transcript_
     *   context passes a longer timeout for exactly that call; every other caller keeps the default.
     * @return array{status:int, body:mixed, raw:string}
     */
    public static function request(string $method, string $url, array $headers = [], ?string $body = null, int $timeoutSeconds = 30): array
    {
        $ch = curl_init($url);
        $headerLines = [];
        foreach ($headers as $k => $v) {
            $headerLines[] = "$k: $v";
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeoutSeconds,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            throw new RuntimeException("HTTP $method $url failed: $err");
        }
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $decoded = json_decode($raw, true);
        return ['status' => $status, 'body' => $decoded, 'raw' => $raw];
    }

    public static function getJson(string $url, array $headers = []): array
    {
        return self::request('GET', $url, $headers);
    }

    public static function postJson(string $url, array $headers, array $payload, int $timeoutSeconds = 30): array
    {
        $headers['Content-Type'] = 'application/json';
        return self::request('POST', $url, $headers, json_encode($payload), $timeoutSeconds);
    }

    public static function patchJson(string $url, array $headers, array $payload): array
    {
        $headers['Content-Type'] = 'application/json';
        return self::request('PATCH', $url, $headers, json_encode($payload));
    }

    public static function postForm(string $url, array $headers, array $formFields): array
    {
        return self::request('POST', $url, $headers, http_build_query($formFields));
    }
}
