import { Schema } from "effect"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { ProductId } from "./Product.js"

export const SagaLogId = Schema.UUID.pipe(
  Schema.brand("SagaLogId"),
  Schema.annotations({ description: "Saga Identification" })
)
export type SagaLogId = typeof SagaLogId.Type

export const SagaLogSchema = Schema.Struct({
  sagaLogId: SagaLogId,
  idempotencyKey: IdempotencyKey,
  orderId: Schema.optionalWith(Schema.NullOr(OrderId), { default: () => null }),
  customerId: CustomerId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" }),
  status: Schema.optionalWith(
    Schema.Literal("STARTED", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATING", "COMPENSATED"),
    { default: () => "STARTED" }
  ).annotations({ description: "Status" }),
  steps: Schema.Array(Schema.Struct({
    stepName: Schema.Literal("CREATE_ORDER", "PROCESS_PAYMENT", "UPDATE_INVENTORY", "DELIVER_ORDER")
      .annotations({ description: "Step Name" }),
    status: Schema.optionalWith(
      Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATED"),
      { default: () => "PENDING" }
    )
      .annotations({ description: "Status" }),
    timestamp: Schema.optionalWith(Schema.NullOr(Schema.Date), { default: () => null }).annotations({
      description: "Timestamp"
    }),
    error: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }).annotations({
      description: "Error"
    }),
    compensationStatus: Schema.optionalWith(Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"), {
      default: () => "PENDING"
    })
      .annotations({ description: "Compensation Status" })
  })),
  createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "SagaLog", identifier: "SagaLog" })
)
export type ServiceSchema = typeof SagaLogSchema.Type

export class SagaLog extends Schema.Class<SagaLog>("SagaLog")(SagaLogSchema) {
  static decodeUnknown = Schema.decodeUnknown(SagaLog)
}
