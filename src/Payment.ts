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
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { Console, Context, Effect, flow, Layer, Logger, LogLevel, Redacted, Schema, String } from "effect"
import * as http from "node:http"
import { v7 as uuidv7 } from "uuid"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import {
  ApplicationLayer as OutboxApplicationLayer,
  Outbox,
  OutboxId,
  OutboxRepository,
  OutboxRepositoryLive
} from "./Outbox.js"
import { SagaLog, SagaLogId, SagaLogRepository, SagaLogRepositoryLive } from "./SagaLog.js"

const PaymentId = Schema.UUID.pipe(
  Schema.brand("PaymentId"),
  Schema.annotations({ description: "Payment Identification" })
)
type PaymentId = typeof PaymentId.Type

const PaymentSchema = Schema.Struct({
  id: PaymentId,
  amount: Schema.Number.annotations({ description: "Amount" }),
  compensationKey: Schema.optionalWith(Schema.NullOr(IdempotencyKey), { default: () => null }),
  customerId: CustomerId,
  idempotencyKey: IdempotencyKey,
  orderId: OrderId,
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
type PaymentSchema = typeof PaymentSchema.Type

class Payment extends Schema.Class<Payment>("Payment")(PaymentSchema) {
  static decodeUnknown = Schema.decodeUnknown(Payment)
}

class PaymentRepository extends Context.Tag("@context/PaymentRepository")<
  PaymentRepository,
  {
    readonly findOne: (options: {
      idempotencyKey?: IdempotencyKey
      orderSagaLog?: {
        orderId: OrderId
        sagaLogId: SagaLogId
      }
      paymentId?: PaymentId
    }) => Effect.Effect<Payment>
    readonly save: (data: Payment) => Effect.Effect<Payment>
  }
>() {}

const PaymentRepositoryLive = Layer.effect(
  PaymentRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'payment_status'
  ) THEN
    CREATE TYPE payment_status AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'REFUNDED');
  END IF;
END
$$;
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
CREATE TABLE IF NOT EXISTS tbl_payment (
    id UUID PRIMARY KEY,
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    compensation_key UUID,
    customer_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    order_id UUID NOT NULL,
    saga_log_id UUID NOT NULL,
    status payment_status NOT NULL DEFAULT 'PENDING'
);
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
CREATE INDEX IF NOT EXISTS idx_payments_order_id_saga_log_id ON tbl_payment(order_id, saga_log_id);
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
CREATE INDEX IF NOT EXISTS idx_payments_idempotency_key ON tbl_payment(idempotency_key);
    `.pipe(Effect.catchTag("SqlError", Effect.die))

    return {
      findOne: ({ idempotencyKey, orderSagaLog, paymentId }) =>
        (idempotencyKey ?
          sql`SELECT * FROM tbl_payment WHERE idempotency_key = ${idempotencyKey} LIMIT 1` :
          orderSagaLog ?
          sql`SELECT * FROM tbl_payment WHERE order_id = ${orderSagaLog.orderId} AND saga_log_id = ${orderSagaLog.sagaLogId} LIMIT 1` :
          paymentId ?
          sql`SELECT * FROM tbl_payment WHERE id = ${paymentId} LIMIT 1` :
          sql`SELECT * FROM tbl_payment LIMIT 1`).pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0])),
            Effect.flatMap((row) => Payment.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          ),
      save: (data) =>
        sql`
INSERT INTO tbl_payment ${sql.insert({ ...data })}
ON CONFLICT (id) 
DO UPDATE SET
    amount = EXCLUDED.amount,
    compensation_key = EXCLUDED.compensation_key,
    customer_id = EXCLUDED.customer_id,
    idempotency_key = EXCLUDED.idempotency_key,
    order_id = EXCLUDED.order_id,
    saga_log_id = EXCLUDED.saga_log_id,
    status = EXCLUDED.status
RETURNING *;
`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((rows) => Effect.succeed(rows[0])),
          Effect.flatMap((row) => Payment.decodeUnknown(row)),
          Effect.catchTag("ParseError", Effect.die)
        )
    }
  })
)

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
  (handlers) =>
    Effect.gen(function*() {
      const outboxRepository = yield* OutboxRepository
      const paymentRepository = yield* PaymentRepository
      const sagaLogRepository = yield* SagaLogRepository

      return handlers.handle(
        "process",
        ({ headers: { "idempotency-key": idempotencyKey }, payload: { amount, customerId, orderId, sagaLogId } }) =>
          Effect.gen(function*() {
            yield* Console.log(
              `[Payment Service] Payment start ${{ idempotencyKey, amount, customerId, orderId, sagaLogId }}`
            )
            // Check if payment already processed
            const existingPayment = yield* paymentRepository.findOne({ idempotencyKey })
            if (existingPayment) {
              yield* Console.log(`[Payment Service] Payment already processed with key: ${idempotencyKey}`)
              return {
                data: existingPayment,
                message: "Payment already processed",
                success: true
              }
            }
            // Get saga log to track progress
            let sagaLog = yield* sagaLogRepository.findOne({ sagaLogId })
            if (!sagaLog) {
              console.error(`[Payment Service] SagaLog not found for sagaLogId: ${sagaLogId}`)
              // throw new Error("SagaLog not found")
              return {
                message: "SagaLog not found",
                success: false
              }
            }
            // Execute payment and outbox write without transaction for now
            // try {
            // Re-fetch sagaLog to ensure we have the latest version
            // sagaLog = await SagaLog.findOne({ sagaLogId })
            // if (!sagaLog) {
            //   // throw new Error("SagaLog not found")
            //   return {
            //     message: "SagaLog not found",
            //     success: false
            //   }
            // }
            // Simulate payment processing - randomly succeed or fail for demo
            const shouldFail = Math.random() < 0.1 // 10% failure rate for demo
            const status = shouldFail ? "FAILED" : "PROCESSED"
            const payment = new Payment({
              id: PaymentId.make(uuidv7()),
              idempotencyKey,
              orderId,
              customerId,
              amount,
              sagaLogId,
              status
            })
            yield* paymentRepository.save(payment)
            // Update saga log
            sagaLog = new SagaLog({
              ...sagaLog,
              steps: sagaLog.steps.map((step) =>
                step.name === "PROCESS_PAYMENT"
                  ? { ...step, status: "IN_PROGRESS", timestamp: new Date() }
                  : step
              )
            })
            yield* sagaLogRepository.save(sagaLog)
            if (shouldFail) {
              yield* Console.log(`[Payment Service] Payment failed`)
              // Update saga log
              sagaLog = new SagaLog({
                ...sagaLog,
                steps: sagaLog.steps.map((step) =>
                  step.name === "PROCESS_PAYMENT"
                    ? { ...step, status: "FAILED", error: "Payment declined" }
                    : step
                )
              })
              yield* sagaLogRepository.save(sagaLog)
              // throw new Error("Payment declined")
              return {
                error: "Payment declined",
                message: "Error processing payment",
                success: false
              }
            }
            yield* Console.log(`[Payment Service] Payment processed`)
            // Update saga log
            sagaLog = new SagaLog({
              ...sagaLog,
              steps: sagaLog.steps.map((step) =>
                step.name === "PROCESS_PAYMENT"
                  ? { ...step, status: "COMPLETED" }
                  : step
              )
            })
            yield* sagaLogRepository.save(sagaLog)
            // Write inventory event to Outbox
            yield* Console.log(`[Payment Service] Writing inventory event to Outbox`)
            const outboxEntry = new Outbox({
              id: OutboxId.make(uuidv7()),
              aggregateId: orderId,
              eventType: "PAYMENT_PROCESSED",
              payload: {
                orderId,
                sagaLogId,
                productId: sagaLog.productId || "unknown",
                quantity: sagaLog.quantity || 1
              },
              targetService: "INVENTORY",
              targetEndpoint: "/inventories/update-inventory",
              isPublished: false
            })
            yield* outboxRepository.save(outboxEntry)
            yield* Console.log(`[Payment Service] Inventory event written to Outbox: ${outboxEntry.id}`)
            return {
              data: payment,
              message: "Payment processed - inventory event queued",
              success: true
            }
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
            let payment = yield* paymentRepository.findOne({ orderSagaLog: { orderId, sagaLogId } })
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
              return {
                data: payment,
                message: "Payment already refunded",
                success: true
              }
            }
            // const updatedPayment = await Payment.findOneAndUpdate(
            //   { _id: payment._id },
            //   {
            //     status: "REFUNDED",
            //     compensationKey: idempotencyKey
            //   },
            //   { new: true }
            // )
            payment = new Payment({
              ...payment,
              status: "REFUNDED",
              compensationKey: idempotencyKey
            })
            payment = yield* paymentRepository.save(payment)
            yield* Console.log(`[Payment Service] Payment refunded: ${orderId}`)
            return {
              data: payment,
              message: "Payment refunded successfully",
              success: true
            }
          })
      ).handle("get", ({ path: { paymentId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Payment Service] Payment get ${{ paymentId }}`
          )
          const payment = yield* paymentRepository.findOne({ paymentId })
          if (!payment) {
            // throw new Error("Payment not found")
            return {
              message: "Payment not found",
              success: false
            }
          }
          return {
            data: payment,
            message: "",
            success: true
          }
        }))
    })
)

const PgLive = PgClient.layer({
  database: "effect_pg_dev",
  password: Redacted.make("password"),
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel,
  username: "postgres"
})

const ApplicationLayer = PaymentHttpApiLive.pipe(
  Layer.provide(
    Layer.provideMerge(
      Layer.mergeAll(
        OutboxApplicationLayer,
        OutboxRepositoryLive,
        PaymentRepositoryLive,
        SagaLogRepositoryLive
      ),
      PgLive
    )
  )
)

const ApiLive = HttpApiBuilder.api(Api)
  .pipe(Layer.provide(ApplicationLayer))

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
