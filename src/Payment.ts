import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpMiddleware,
  HttpServer,
  OpenApi
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import * as HttpApiScalar from "@effect/platform/HttpApiScalar"
import * as HttpApiSwagger from "@effect/platform/HttpApiSwagger"
import { Console, Effect, flow, Layer, Logger, LogLevel, Schema } from "effect"
import * as http from "node:http"
import { v7 as uuidv7 } from "uuid"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { EventId, Outbox } from "./Outbox.js"
import { SagaLog, SagaLogId } from "./SagaLog.js"

const PaymentId = Schema.UUID.pipe(
  Schema.brand("PaymentId"),
  Schema.annotations({ description: "Payment Identification" })
)
type PaymentId = typeof PaymentId.Type

const PaymentSchema = Schema.Struct({
  amount: Schema.Number.annotations({ description: "Amount" }),
  customerId: CustomerId,
  idempotencyKey: IdempotencyKey,
  orderId: OrderId,
  paymentId: PaymentId,
  sagaLogId: SagaLogId,
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "PROCESSED", "FAILED", "REFUNDED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" })
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Payment", identifier: "Payment" })
)
type ServiceSchema = typeof PaymentSchema.Type

class Payment extends Schema.Class<Payment>("Payment")(PaymentSchema) {
  static decodeUnknown = Schema.decodeUnknown(Payment)
}

const PaymentProcessRequest = Schema.Struct({
  amount: Schema.Number.annotations({ description: "Amount" }),
  customerId: CustomerId,
  orderId: OrderId,
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Payment Process Request", identifier: "PaymentProcessRequest" })
)
type PaymentProcessRequest = typeof PaymentProcessRequest.Type

const PaymentRefundRequest = Schema.Struct({
  orderId: OrderId,
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Payment Refund Request", identifier: "PaymentRefundRequest" })
)
type PaymentRefundRequest = typeof PaymentRefundRequest.Type

class PaymentHttpApiGroup extends HttpApiGroup.make("payment")
  .add(
    HttpApiEndpoint.post("process", "/process")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(PaymentProcessRequest)
      .annotate(OpenApi.Description, "Payment Start")
      .annotate(OpenApi.Summary, "Payment Start")
  )
  .add(
    HttpApiEndpoint.post("refund", "/refund")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(PaymentRefundRequest)
      .annotate(OpenApi.Description, "Payment Refund")
      .annotate(OpenApi.Summary, "Payment Refund")
  )
  .add(
    HttpApiEndpoint.get("get", "/:paymentId")
      .addSuccess(Schema.Struct({}))
      .setPath(Schema.Struct({ paymentId: PaymentId }))
      .annotate(OpenApi.Description, "Payment Get")
      .annotate(OpenApi.Summary, "Payment Get")
  )
  .annotate(OpenApi.Description, "Manage Payment")
  .annotate(OpenApi.Summary, "Manage Payment")
  .annotate(OpenApi.Title, "Payment")
  .prefix("/payment")
{}

const Api = HttpApi.make("api")
  .add(PaymentHttpApiGroup)
  .annotate(OpenApi.Description, "Manage Payment API")
  .annotate(OpenApi.Summary, "Manage Payment API")
  .annotate(OpenApi.Title, "Payment API")
  .prefix("/api/v1")

const PaymentHttpApiLive = HttpApiBuilder.group(
  Api,
  "payment",
  (handlers) => {
    return handlers.handle(
      "process",
      ({ headers: { "idempotency-key": idempotencyKey }, payload: { amount, customerId, orderId, sagaLogId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Payment Service] Payment start ${{ idempotencyKey, amount, customerId, orderId, sagaLogId }}`
          )
          // Check if payment already processed
          const existingPayment = await Payment.findOne({ idempotencyKey })
          if (existingPayment) {
            yield* Console.log(`[Payment Service] Payment already processed with key: ${idempotencyKey}`)
            return {
              data: existingPayment,
              message: "Payment already processed",
              success: true
            }
          }

          // Get saga log to track progress
          let sagaLog = await SagaLog.findOne({ sagaLogId })

          if (!sagaLog) {
            console.error(`[Payment Service] SagaLog not found for sagaLogId: ${sagaLogId}`)
            // throw new Error("Saga not found")
            return {
              message: "Saga not found",
              success: false
            }
          }

          // Execute payment and outbox write without transaction for now
          // try {
          // Re-fetch sagaLog to ensure we have the latest version
          sagaLog = await SagaLog.findOne({ sagaLogId })

          if (!sagaLog) {
            throw new Error("SagaLog not found")
          }

          // Simulate payment processing - randomly succeed or fail for demo
          const shouldFail = Math.random() < 0.1 // 10% failure rate for demo

          const status = shouldFail ? "FAILED" : "PROCESSED"

          const payment = new Payment({
            paymentId: PaymentId.make(uuidv7()),
            idempotencyKey,
            orderId,
            customerId,
            amount,
            sagaLogId,
            status
          })

          await payment.save()

          // Update saga log
          const paymentStep = sagaLog.steps.find((s) => s.stepName === "PROCESS_PAYMENT")
          paymentStep.status = "IN_PROGRESS"
          paymentStep.timestamp = new Date()
          await sagaLog.save()

          if (shouldFail) {
            yield* Console.log(`[Payment Service] Payment failed`)

            // Update saga log
            paymentStep.status = "FAILED"
            paymentStep.error = "Payment declined"
            await sagaLog.save()

            throw new Error("Payment declined")
          }

          yield* Console.log(`[Payment Service] Payment processed`)

          // Update saga log
          paymentStep.status = "COMPLETED"
          await sagaLog.save()

          // Write inventory event to Outbox
          yield* Console.log(`[Payment Service] Writing inventory event to Outbox`)

          const inventoryEventId = EventId.make(uuidv7())
          const outboxEntry = new Outbox({
            eventId: inventoryEventId,
            aggregateId: orderId,
            eventType: "PaymentProcessed",
            payload: {
              orderId,
              sagaLogId,
              productId: sagaLog.productId || "unknown",
              quantity: sagaLog.quantity || 1
            },
            targetService: "inventory",
            targetEndpoint: "/inventories/update-inventory",
            isPublished: false
          })

          await outboxEntry.save()
          yield* Console.log(`[Payment Service] Inventory event written to Outbox: ${inventoryEventId}`)

          return { outboxEntry, payment }
          // } catch (innerError) {
          //   throw innerError
          // }

          // return {
          //   message: "Payment processed - inventory event queued",
          //   success: true
          // }
        })
    ).handle(
      "refund",
      ({ headers: { "idempotency-key": idempotencyKey }, payload: { orderId, sagaLogId } }) =>
        Effect.gen(function*() {
          yield* Console.log(`[Payment Service] Payment refund ${{ idempotencyKey, orderId, sagaLogId }}`)
          const payment = await Payment.findOne({ orderId, sagaLogId })

          if (!payment) {
            // throw new Error("Payment not found")
            return {
              message: "Payment not found",
              success: false
            }
          }

          // Mark as already refunded if compensation key matches
          if (payment.compensationKey === idempotencyKey) {
            yield* Console.log(`[Payment Service] Payment already refunded with key: ${idempotencyKey}`)
            return res.status(200).json({
              data: payment,
              message: "Payment already refunded",
              success: true
            })
          }

          const updatedPayment = await Payment.findOneAndUpdate(
            { _id: payment._id },
            {
              status: "REFUNDED",
              compensationKey: idempotencyKey
            },
            { new: true }
          )

          yield* Console.log(`[Payment Service] Payment refunded: ${orderId}`)

          return {
            data: updatedPayment,
            message: "Payment refunded successfully",
            success: true
          }
        })
    ).handle("get", ({ path: { paymentId } }) =>
      Effect.gen(function*() {
        yield* Console.log(
          `[Payment Service] Payment get ${{ paymentId }}`
        )
        const payment = await Payment.findOne({ paymentId })

        if (!payment) {
          // throw new Error("Payment not found")
          return {
            message: "Payment not found",
            success: false
          }
        }

        return {
          data: payment,
          success: true
        }
      }))
  }
)

const ApiLive = HttpApiBuilder.api(Api)
  .pipe(Layer.provide(PaymentHttpApiLive))

const gracefulShutdown = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.scopedDiscard(
    Effect.addFinalizer(() => Effect.logInfo("Graceful Shutdown"))
  ).pipe(
    Layer.provideMerge(layer)
  )

HttpApiBuilder.serve(flow(
  HttpMiddleware.cors({
    allowedOrigins: [
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:3002",
      "http://127.0.0.1:3003",
      "http://127.0.0.1:3004"
    ],
    allowedMethods: ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"],
    allowedHeaders: ["authorization", "b3", "content-type", "idempotency-key", "traceparent"],
    exposedHeaders: ["authorization", "content-type"],
    credentials: true,
    maxAge: 86400
  }),
  HttpMiddleware.logger
)).pipe(
  // Layer.provide(NodeSdkLive),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" })),
  Layer.provide(HttpApiScalar.layer({ path: "/reference" })),
  Layer.provide(HttpApiSwagger.layer({ path: "/doc" })),
  Layer.provide(ApiLive),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Debug)),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(http.createServer, { port: 3002 })),
  gracefulShutdown,
  Layer.launch,
  NodeRuntime.runMain
)
