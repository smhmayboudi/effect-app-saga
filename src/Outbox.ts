import { Schema } from "effect"

export const EventId = Schema.UUID.pipe(
  Schema.brand("EventId"),
  Schema.annotations({ description: "Event Identification" })
)
export type EventId = typeof EventId.Type

export const AggregateId = Schema.UUID.pipe(
  Schema.brand("AggregateId"),
  Schema.annotations({ description: "Aggregate Identification" })
)
export type AggregateId = typeof AggregateId.Type

export const OutboxSchema = Schema.Struct({
  eventId: EventId,
  aggregateId: AggregateId,
  eventType: Schema.Literal(
    "OrderCreated",
    "PaymentProcessed",
    "PaymentFailed",
    "InventoryUpdated",
    "InventoryFailed",
    "OrderShipped",
    "OrderDelivered",
    "OrderCompensated"
  ).annotations({ description: "Event Type" }),
  payload: Schema.Unknown,
  targetService: Schema.Literal("payment", "inventory", "shipping", "order")
    .annotations({ description: "Target Service" }),
  targetEndpoint: Schema.String.annotations({ description: "Target Endpoint" }),
  published: Schema.optionalWith(Schema.Boolean.annotations({ description: "Published" }), { default: () => false }),
  publishedAt: Schema.optionalWith(Schema.NullOr(Schema.Date).annotations({ description: "Published At" }), {
    default: () => null
  }),
  publishAttempts: Schema.optionalWith(Schema.Number.annotations({ description: "Publish Attempts" }), {
    default: () => 0
  }),
  maxRetries: Schema.optionalWith(Schema.Number.annotations({ description: "Max Retries" }), { default: () => 3 }),
  lastError: Schema.optionalWith(Schema.NullOr(Schema.String).annotations({ description: "Last Error" }), {
    default: () => null
  }),
  createdAt: Schema.optionalWith(Schema.Date.annotations({ description: "Created At" }), { default: () => new Date() })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Outbox", identifier: "Outbox" })
)
export type ServiceSchema = typeof OutboxSchema.Type

export class Outbox extends Schema.Class<Outbox>("Outbox")(OutboxSchema) {
  static decodeUnknown = Schema.decodeUnknown(Outbox)
}
