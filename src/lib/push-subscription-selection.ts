export type PushSubscriptionTarget = {
  endpoint: string;
};

export type PushDeliveryOptions = {
  excludeEndpoints?: Iterable<string>;
};

export function selectPushSubscriptions<T extends PushSubscriptionTarget>(
  subscriptions: T[],
  options: PushDeliveryOptions = {},
) {
  const excludedEndpoints = new Set(options.excludeEndpoints || []);
  return subscriptions.filter((subscription) => !excludedEndpoints.has(subscription.endpoint));
}
