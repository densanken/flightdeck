import { raceWithSignal, throwIfAborted } from "../../util/timeout.js";

import type { DeliveryRepository, WebhookFeature } from "./interface.js";

export const DELIVERY_CACHE_NAME = "preflight:deliveries";

const CACHE_KEY_BASE_URL = "https://cache.internal/github/deliveries/";
const DEFAULT_OPERATION_TIMEOUT_MS = 500;

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface CacheStorageLike {
  open(cacheName: string): Promise<CacheLike>;
}

export const createDeliveryCacheKey = (input: { deliveryId: string; feature: WebhookFeature }): Request =>
  new Request(`${CACHE_KEY_BASE_URL}${encodeURIComponent(input.deliveryId)}/${encodeURIComponent(input.feature)}`, {
    method: "GET",
  });

const withTimeout = async <T>(operation: () => Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> => {
  await throwIfAborted(signal);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Cache operation timed out"));
    }, timeoutMs);
  });
  try {
    return await raceWithSignal(Promise.race([operation(), timeout]), signal);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

export class CacheDeliveryRepository implements DeliveryRepository {
  constructor(
    private readonly ttlSeconds: number,
    private readonly storage: CacheStorageLike = caches,
    private readonly operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
  ) {}

  has(deliveryId: string, feature: WebhookFeature, signal: AbortSignal): Promise<boolean> {
    return withTimeout(() => this.read(deliveryId, feature), this.operationTimeoutMs, signal);
  }

  markProcessed(deliveryId: string, feature: WebhookFeature, processedAt: Date, signal: AbortSignal): Promise<void> {
    return withTimeout(() => this.write(deliveryId, feature, processedAt), this.operationTimeoutMs, signal);
  }

  private async read(deliveryId: string, feature: WebhookFeature): Promise<boolean> {
    const cache = await this.storage.open(DELIVERY_CACHE_NAME);
    return (await cache.match(createDeliveryCacheKey({ deliveryId, feature }))) !== undefined;
  }

  private async write(deliveryId: string, feature: WebhookFeature, processedAt: Date): Promise<void> {
    const cache = await this.storage.open(DELIVERY_CACHE_NAME);
    const response = new Response(JSON.stringify({ processedAt: processedAt.toISOString() }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${String(this.ttlSeconds)}`,
      },
    });
    await cache.put(createDeliveryCacheKey({ deliveryId, feature }), response);
  }
}
