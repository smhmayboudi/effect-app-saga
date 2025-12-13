import { Schema } from "effect"
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
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" }),
  status: Schema.optionalWith(
    Schema.Literal("STARTED", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATING", "COMPENSATED")
      .annotations({ description: "Status" }),
    { default: () => "STARTED" }
  ),
  steps: Schema.Array(Schema.Struct({
    stepName: Schema.Literal("CREATE_ORDER", "PROCESS_PAYMENT", "UPDATE_INVENTORY", "DELIVER_ORDER")
      .annotations({ description: "Step Name" }),
    status: Schema.optionalWith(
      Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "COMPENSATED")
        .annotations({ description: "Status" }),
      { default: () => "PENDING" }
    ),
    timestamp: Schema.Date,
    error: Schema.String,
    compensationStatus: Schema.Literal("PENDING", "IN_PROGRESS", "COMPLETED", "FAILED")
      .annotations({ description: "Compensation Status" })
  })),
  createdAt: Schema.optionalWith(Schema.Date.annotations({ description: "Created At" }), { default: () => new Date() })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "SagaLog", identifier: "SagaLog" })
)
export type ServiceSchema = typeof SagaLogSchema.Type

export class SagaLog extends Schema.Class<SagaLog>("SagaLog")(SagaLogSchema) {
  static decodeUnknown = Schema.decodeUnknown(SagaLog)
}
