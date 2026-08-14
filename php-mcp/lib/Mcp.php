<?php
declare(strict_types=1);

/**
 * Minimal MCP "Streamable HTTP" transport server — no official PHP MCP SDK exists, so this hand-
 * implements just the JSON-RPC 2.0 envelope this project's tools actually need: initialize,
 * notifications/initialized, tools/list, tools/call. Deliberately stateless (no Mcp-Session-Id
 * issued) — the spec makes session management optional, and none of these tools need server-side
 * conversation state, so skipping it is the honest minimum, not a corner cut.
 */
final class Mcp
{
    /** @var array<string, array{schema: array, handler: callable}> */
    private array $tools = [];

    public function registerTool(string $name, array $schema, callable $handler): void
    {
        $this->tools[$name] = ['schema' => $schema, 'handler' => $handler];
    }

    public function handleRequest(): void
    {
        header('Content-Type: application/json');

        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            http_response_code(405);
            echo json_encode(['error' => 'This MCP server only supports POST (no server-initiated streaming).']);
            return;
        }

        $raw = file_get_contents('php://input');
        $message = json_decode($raw, true);
        if (!is_array($message)) {
            http_response_code(400);
            echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'Parse error']]);
            return;
        }

        $id = $message['id'] ?? null;
        $method = $message['method'] ?? '';
        $params = $message['params'] ?? [];

        // Notifications carry no id and expect no response body at all.
        if ($id === null && str_starts_with($method, 'notifications/')) {
            http_response_code(202);
            return;
        }

        try {
            $result = match ($method) {
                'initialize' => [
                    'protocolVersion' => $params['protocolVersion'] ?? '2025-06-18',
                    'capabilities' => ['tools' => new stdClass()],
                    'serverInfo' => ['name' => 'hhhh-enterprise-knowledge-php', 'version' => '1.0.0'],
                ],
                'tools/list' => ['tools' => array_map(
                    fn($name, $t) => array_merge(['name' => $name], $t['schema']),
                    array_keys($this->tools),
                    $this->tools
                )],
                'tools/call' => $this->callTool($params['name'] ?? '', $params['arguments'] ?? []),
                'ping' => new stdClass(),
                default => throw new RuntimeException("Unknown method: $method"),
            };
            echo json_encode(['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]);
        } catch (Throwable $e) {
            echo json_encode(['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => -32603, 'message' => $e->getMessage()]]);
        }
    }

    private function callTool(string $name, array $arguments): array
    {
        if (!isset($this->tools[$name])) {
            throw new RuntimeException("Unknown tool: $name");
        }
        $text = ($this->tools[$name]['handler'])($arguments);
        return ['content' => [['type' => 'text', 'text' => $text]]];
    }
}
