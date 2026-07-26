export type PushSubscriptionTarget = {
  endpoint: string;
};

export type PushDeliveryOptions = {
  excludeEndpoints?: Iterable<string>;
  excludeAppleWebPush?: boolean;
};

export function isAppleWebPushEndpoint(endpoint: string) {
  try {
    return new URL(endpoint).hostname === "web.push.apple.com";
  } catch {
    return false;
  }
}

export function selectPushSubscriptions<T extends PushSubscriptionTarget>(
  subscriptions: T[],
  options: PushDeliveryOptions = {},
) {
  const excludedEndpoints = new Set(options.excludeEndpoints || []);
  return subscriptions.filter((subscription) => (
    !excludedEndpoints.has(subscription.endpoint)
    && !(options.excludeAppleWebPush && isAppleWebPushEndpoint(subscription.endpoint))
  ));
}
