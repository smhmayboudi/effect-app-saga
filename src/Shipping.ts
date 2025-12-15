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
import { Console, Context, Effect, flow, Layer, Logger, LogLevel, Schema, String } from "effect"
import * as http from "node:http"
import { v7 as uuidv7 } from "uuid"
import { CustomerId } from "./Customer.js"
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { SagaLogId, SagaLogRepository } from "./SagaLog.js"

const ShippingId = Schema.UUID.pipe(
  Schema.brand("ShippingId"),
  Schema.annotations({ description: "Shipping Identification" })
)
type ShippingId = typeof ShippingId.Type

const ShippingSchema = Schema.Struct({
  compensationKey: Schema.optionalWith(Schema.NullOr(IdempotencyKey), { default: () => null }),
  customerId: CustomerId,
  id: ShippingId,
  idempotencyKey: IdempotencyKey,
  orderId: OrderId,
  sagaLogId: SagaLogId,
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "SHIPPED", "DELIVERED", "CANCELLED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" })
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Shipping", identifier: "Shipping" })
)
type ShippingSchema = typeof ShippingSchema.Type

class Shipping extends Schema.Class<Shipping>("Shipping")(ShippingSchema) {
  static decodeUnknown = Schema.decodeUnknown(Shipping)
}

class ShippingRepository extends Context.Tag("@context/ShippingRepository")<
  ShippingRepository,
  {
    readonly findOne: (options: {
      compensationOrder?: {
        compensationKey: IdempotencyKey
        orderId: OrderId
      }
      idempotencyKey?: IdempotencyKey
      sagaLogId?: SagaLogId
      shippingId?: ShippingId
    }) => Effect.Effect<Shipping>
    readonly save: (data: Shipping) => Effect.Effect<Shipping>
  }
>() {}

const ShippingRepositoryLive = Layer.effect(
  ShippingRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
-- Create ENUM type for shipping status
CREATE TYPE shipping_status AS ENUM ('PENDING', 'SHIPPED', 'DELIVERED', 'CANCELLED');
    `
    yield* sql`
-- Create the shipping table without foreign key constraints
CREATE TABLE tbl_shipping (
    id UUID PRIMARY KEY,
    customer_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    order_id UUID NOT NULL,
    saga_log_id UUID NOT NULL,
    status shipping_status NOT NULL DEFAULT 'PENDING',
    
    compensation_key UUID,

    -- Indexes for better performance
    INDEX idx_shipping_customer_id ON (customer_id),
    INDEX idx_shipping_order_id ON (order_id),
    INDEX idx_shipping_status ON (status),
    INDEX idx_shipping_saga_log_id ON (saga_log_id),
    INDEX idx_shipping_idempotency_key ON (idempotency_key),
    
    -- Add unique constraints only
    CONSTRAINT unique_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT unique_order_id UNIQUE (order_id)
);
    `

    return {
      findOne: ({ compensationOrder, idempotencyKey, sagaLogId, shippingId }) =>
        (compensationOrder ?
          sql`SELECT * FROM tbl_shipping WHERE compensation_key = ${compensationOrder.compensationKey} AND order_id = ${compensationOrder.orderId} LIMIT 1` :
          idempotencyKey ?
          sql`SELECT * FROM tbl_shipping WHERE idempotency_key = ${idempotencyKey} LIMIT 1` :
          sagaLogId ?
          sql`SELECT * FROM tbl_shipping WHERE saga_log_id = ${sagaLogId} LIMIT 1` :
          shippingId ?
          sql`SELECT * FROM tbl_shipping WHERE shipping_id = ${shippingId} LIMIT 1` :
          sql`SELECT * FROM tbl_shipping LIMIT 1`).pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0])),
            Effect.flatMap((row) => Shipping.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          ),
      save: (data) =>
        sql`
INSERT INTO tbl_shipping ${sql.insert({ ...data })}
ON CONFLICT (id) 
DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    idempotency_key = EXCLUDED.idempotency_key,
    order_id = EXCLUDED.order_id,
    saga_log_id = EXCLUDED.saga_log_id,
    status = EXCLUDED.status,
    compensation_key = EXCLUDED.compensation_key
RETURNING *;
`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((rows) => Effect.succeed(rows[0])),
          Effect.flatMap((row) => Shipping.decodeUnknown(row)),
          Effect.catchTag("ParseError", Effect.die)
        )
    }
  })
)

const ShippingDeliverRequest = Schema.Struct({
  customerId: CustomerId,
  orderId: OrderId,
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Shipping Deliver Request", identifier: "ShippingDeliverRequest" })
)
type ShippingDeliverRequest = typeof ShippingDeliverRequest.Type

const ShippingCancelRequest = Schema.Struct({
  orderId: OrderId,
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Shipping Cancel Request", identifier: "ShippingCancelRequest" })
)
type ShippingCancelRequest = typeof ShippingCancelRequest.Type

class ShippingHttpApiGroup extends HttpApiGroup.make("shipping")
  .add(
    HttpApiEndpoint.post("deliver", "/deliver")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(ShippingDeliverRequest)
      .annotate(OpenApi.Description, "Shipping Start")
      .annotate(OpenApi.Summary, "Shipping Start")
  )
  .add(
    HttpApiEndpoint.post("cancel", "/cancel")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(ShippingCancelRequest)
      .annotate(OpenApi.Description, "Shipping Refund")
      .annotate(OpenApi.Summary, "Shipping Refund")
  )
  .add(
    HttpApiEndpoint.get("get", "/:shippingId")
      .addSuccess(Schema.Struct({}))
      .setPath(Schema.Struct({ shippingId: ShippingId }))
      .annotate(OpenApi.Description, "Shipping Get")
      .annotate(OpenApi.Summary, "Shipping Get")
  )
  .annotate(OpenApi.Description, "Manage Shipping")
  .annotate(OpenApi.Summary, "Manage Shipping")
  .annotate(OpenApi.Title, "Shipping")
  .prefix("/shipping")
{}

const Api = HttpApi.make("api")
  .add(ShippingHttpApiGroup)
  .annotate(OpenApi.Description, "Manage Shipping API")
  .annotate(OpenApi.Summary, "Manage Shipping API")
  .annotate(OpenApi.Title, "Shipping API")
  .prefix("/api/v1")

const ShippingHttpApiLive = HttpApiBuilder.group(
  Api,
  "shipping",
  (handlers) =>
    Effect.gen(function*() {
      const sagaLogRepository = yield* SagaLogRepository
      const shippingRepository = yield* ShippingRepository

      return handlers.handle(
        "deliver",
        ({ headers: { "idempotency-key": idempotencyKey }, payload: { customerId, orderId, sagaLogId } }) =>
          Effect.gen(function*() {
            yield* Console.log(
              `[Shipping Service] Shipping deliver ${{ idempotencyKey, customerId, orderId, sagaLogId }}`
            )
            // Check if shipping already created
            const existingShipping = yield* shippingRepository.findOne({ idempotencyKey })
            if (existingShipping) {
              yield* Console.log(`[Shipping Service] Shipping already created with key: ${idempotencyKey}`)
              return {
                data: existingShipping,
                message: "Shipping already created",
                sagaLogId,
                success: true
              }
            }

            // Get saga log to track progress
            const sagaLog = yield* sagaLogRepository.findOne({ sagaLogId })
            if (!sagaLog) {
              // throw new Error("SagaLog not found")
              return {
                message: "SagaLog not found",
                success: false
              }
            }

            // Execute shipping creation and saga completion without transaction
            // try {
            let shipping = new Shipping({
              id: ShippingId.make(uuidv7()),
              idempotencyKey,
              orderId,
              customerId,
              status: "SHIPPED",
              sagaLogId
            })

            shipping = yield* shippingRepository.save(shipping)
            yield* Console.log(`[Shipping Service] Shipping created: ${orderId}`)

            // Update saga log
            const shippingStep = sagaLog.steps.find((s) => s.stepName === "DELIVER_ORDER")
            if (shippingStep) {
              shippingStep.status = "IN_PROGRESS"
              shippingStep.timestamp = new Date()
              yield* sagaLogRepository.save(sagaLog)

              yield* Console.log(`[Shipping Service] Order delivered: ${orderId}`)

              // Mark saga as completed
              shippingStep.status = "COMPLETED"
              sagaLog.status = "COMPLETED"
              yield* sagaLogRepository.save(sagaLog)

              yield* Console.log(`[Shipping Service] Saga COMPLETED: ${sagaLogId}\n`)
            } else {
              console.error(`[Shipping Service] DELIVER_ORDER step not found in saga`)
            }

            return shipping
            // } catch (innerError) {
            //   throw innerError
            // }

            // return {
            //   message: "Order shipped successfully and saga completed",
            //   sagaLogId,
            //   success: true
            // }
          })
      ).handle(
        "cancel",
        ({ headers: { "idempotency-key": idempotencyKey }, payload: { orderId, sagaLogId } }) =>
          Effect.gen(function*() {
            yield* Console.log(`[Shipping Service] Shipping cancel ${{ idempotencyKey, orderId, sagaLogId }}`)
            // Check if already cancelled
            let shipping = yield* shippingRepository.findOne({
              compensationOrder: { compensationKey: idempotencyKey, orderId }
            })
            if (shipping) {
              console.log(`[Shipping Service] Shipping already cancelled with key: ${idempotencyKey}`)
              return {
                success: true,
                message: "Shipping already cancelled"
              }
            }

            // shipping = await Shipping.findOneAndUpdate(
            //   { orderId, sagaLogId },
            //   {
            //     status: "CANCELLED",
            //     compensationKey: idempotencyKey
            //   },
            //   { new: true }
            // )

            // TODO: test without orderId
            shipping = yield* shippingRepository.findOne({ sagaLogId })
            if (!shipping) {
              // throw new Error("Shipping not found")
              return {
                message: "Shipping not found",
                success: false
              }
            }

            shipping = new Shipping({
              ...shipping,
              compensationKey: idempotencyKey,
              status: "CANCELLED"
            })
            shipping = yield* shippingRepository.save()

            yield* Console.log(`[Shipping Service] Shipping cancelled: ${orderId}`)

            return {
              data: shipping,
              message: "Shipping cancelled successfully",
              success: true
            }
          })
      ).handle("get", ({ path: { shippingId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Shipping Service] Shipping get ${{ shippingId }}`
          )
          const shipping = yield* shippingRepository.findOne({ shippingId })

          if (!shipping) {
            // throw new Error("Shipping not found")
            return {
              message: "Shipping not found",
              success: false
            }
          }

          return {
            data: shipping,
            success: true
          }
        }))
    })
)

const PgLive = PgClient.layer({
  database: "effect_pg_dev",
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel
})

const ApplicationLayer = Layer.mergeAll(
  ShippingRepositoryLive,
  PgLive
).pipe(Layer.provideMerge(ShippingHttpApiLive))

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
  Layer.provide(NodeHttpServer.layer(http.createServer, { port: 3004 })),
  gracefulShutdown,
  Layer.launch,
  NodeRuntime.runMain
)
