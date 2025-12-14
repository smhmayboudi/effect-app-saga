import { Schema } from "effect"
import { OrderId } from "./Order.js"

export const EventId = Schema.UUID.pipe(
  Schema.brand("EventId"),
  Schema.annotations({ description: "Event Identification" })
)
export type EventId = typeof EventId.Type

export const OutboxSchema = Schema.Struct({
  eventId: EventId,
  aggregateId: OrderId,
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
  published: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({ description: "Published" }),
  publishedAt: Schema.optionalWith(Schema.NullOr(Schema.Date).annotations({ description: "Published At" }), {
    default: () => null
  }),
  publishAttempts: Schema.optionalWith(Schema.Number.annotations({ description: "Publish Attempts" }), {
    default: () => 0
  }),
  maxRetries: Schema.optionalWith(Schema.Number, { default: () => 3 }).annotations({ description: "Max Retries" }),
  lastError: Schema.optionalWith(Schema.NullOr(Schema.String).annotations({ description: "Last Error" }), {
    default: () => null
  }),
  createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Outbox", identifier: "Outbox" })
)
export type ServiceSchema = typeof OutboxSchema.Type

export class Outbox extends Schema.Class<Outbox>("Outbox")(OutboxSchema) {
  static decodeUnknown = Schema.decodeUnknown(Outbox)
}
