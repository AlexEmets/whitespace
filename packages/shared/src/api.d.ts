export interface ApiGroup {
  id: string;
  title: string;
}

export interface ApiParam {
  name: string;
  in: 'path' | 'query';
  description: string;
}

export interface ApiEndpoint {
  method: 'GET' | 'POST';
  /** As the server registers it, with `:name` path parameters. */
  path: string;
  group: string;
  summary: string;
  params: ApiParam[];
  /** The `?limit=` the handler accepts, when it takes one. */
  limit?: { default: number; max: number };
  /** A request to try, relative to the base URL; `:address` is filled with a wallet. */
  example?: string;
  /** Registered by the server but left out of the public reference. */
  internal?: boolean;
}

export interface WsChannel {
  kind: string;
  pattern: string;
  example: string;
  summary: string;
}

export const API_GROUPS: ApiGroup[];
export const API_ENDPOINTS: ApiEndpoint[];
export const WS_CHANNELS: WsChannel[];
export const WS_LIMITS: { pollIntervalMs: number; subscriptionsPerSocket: number; connectionsPerIp: number };
export function publicEndpoints(): ApiEndpoint[];
