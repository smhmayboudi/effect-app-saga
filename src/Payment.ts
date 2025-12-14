import { Schema } from "effect"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { SagaLogId } from "./SagaLog.js"

export const PaymentId = Schema.UUID.pipe(
  Schema.brand("PaymentId"),
  Schema.annotations({ description: "Payment Identification" })
)
export type PaymentId = typeof PaymentId.Type

export const PaymentSchema = Schema.Struct({
  paymentId: PaymentId,
  idempotencyKey: IdempotencyKey,
  orderId: OrderId,
  amount: Schema.Number.annotations({ description: "Amount" }),
  customerId: CustomerId,
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "PROCESSED", "FAILED", "REFUNDED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" }),
  sagaLogId: SagaLogId
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Payment", identifier: "Payment" })
)
export type ServiceSchema = typeof PaymentSchema.Type

export class Payment extends Schema.Class<Payment>("Payment")(PaymentSchema) {
  static decodeUnknown = Schema.decodeUnknown(Payment)
}
