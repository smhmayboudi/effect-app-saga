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
import {
  ApplicationLayer as OutboxApplicationLayer,
  Outbox,
  OutboxId,
  OutboxRepository,
  OutboxRepositoryLive
} from "./Outbox.js"
import { ProductId } from "./Product.js"
import { SagaLog, SagaLogId, SagaLogRepository, SagaLogRepositoryLive } from "./SagaLog.js"

export const OrderId = Schema.UUID.pipe(
  Schema.brand("OrderId"),
  Schema.annotations({ description: "Order Identification" })
)
export type OrderId = typeof OrderId.Type

const OrderSchema = Schema.Struct({
  id: OrderId,
  customerId: CustomerId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  sagaLogId: SagaLogId,
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "CONFIRMED", "FAILED", "COMPENSATED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" })
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Order", identifier: "Order" })
)
type OrderSchema = typeof OrderSchema.Type

class Order extends Schema.Class<Order>("Order")(OrderSchema) {
  static decodeUnknown = Schema.decodeUnknown(Order)
}

class OrderRepository extends Context.Tag("@context/OrderRepository")<
  OrderRepository,
  {
    readonly findOne: (options: {
      orderId?: OrderId
    }) => Effect.Effect<Order>
    readonly save: (data: Order) => Effect.Effect<Order>
  }
>() {}

const OrderRepositoryLive = Layer.effect(
  OrderRepository,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
CREATE TYPE order_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'COMPENSATED');
    `.pipe(Effect.catchTag("SqlError", Effect.die))
    yield* sql`
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL,
    product_id UUID NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    saga_log_id UUID NOT NULL,
    status order_status NOT NULL DEFAULT 'PENDING',
    total_price DECIMAL(10, 2) NOT NULL CHECK (total_price >= 0)
);
    `.pipe(Effect.catchTag("SqlError", Effect.die))

    return {
      findOne: ({ orderId }) =>
        (orderId ?
          sql`SELECT * FROM tbl_order WHERE id = ${orderId} LIMIT 1` :
          sql`SELECT * FROM tbl_order LIMIT 1`).pipe(
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((rows) => Effect.succeed(rows[0])),
            Effect.flatMap((row) => Order.decodeUnknown(row)),
            Effect.catchTag("ParseError", Effect.die)
          ),
      save: (data) =>
        sql`
INSERT INTO tbl_order ${sql.insert({ ...data })}
ON CONFLICT (id) 
DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    product_id = EXCLUDED.product_id,
    quantity = EXCLUDED.quantity,
    saga_log_id = EXCLUDED.saga_log_id,
    status = EXCLUDED.status,
    total_price = EXCLUDED.total_price
RETURNING *;
`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap((rows) => Effect.succeed(rows[0])),
          Effect.flatMap((row) => Order.decodeUnknown(row)),
          Effect.catchTag("ParseError", Effect.die)
        )
    }
  })
)

const OrderStartRequest = Schema.Struct({
  customerId: CustomerId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" })
}).pipe(
  Schema.annotations({ description: "Order Start Request", identifier: "OrderStartRequest" })
)
type OrderStartRequest = typeof OrderStartRequest.Type

const OrderCompensateRequest = Schema.Struct({
  orderId: OrderId
}).pipe(
  Schema.annotations({ description: "Order Compensate Request", identifier: "OrderCompensateRequest" })
)
type OrderCompensateRequest = typeof OrderCompensateRequest.Type

class OrderHttpApiGroup extends HttpApiGroup.make("order")
  .add(
    HttpApiEndpoint.post("start", "/start")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(OrderStartRequest)
      .annotate(OpenApi.Description, "Order Start")
      .annotate(OpenApi.Summary, "Order Start")
  )
  .add(
    HttpApiEndpoint.post("compensate", "/compensate")
      .addSuccess(Schema.Struct({}))
      // .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(OrderCompensateRequest)
      .annotate(OpenApi.Description, "Order Compensate")
      .annotate(OpenApi.Summary, "Order Compensate")
  )
  .add(
    HttpApiEndpoint.get("get", "/:orderId")
      .addSuccess(Schema.Struct({}))
      .setPath(Schema.Struct({ orderId: OrderId }))
      .annotate(OpenApi.Description, "Order Get")
      .annotate(OpenApi.Summary, "Order Get")
  )
  .annotate(OpenApi.Description, "Manage Order")
  .annotate(OpenApi.Summary, "Manage Order")
  .annotate(OpenApi.Title, "Order")
  .prefix("/order")
{}

const Api = HttpApi.make("api")
  .add(OrderHttpApiGroup)
  .annotate(OpenApi.Description, "Manage Order API")
  .annotate(OpenApi.Summary, "Manage Order API")
  .annotate(OpenApi.Title, "Order API")
  .prefix("/api/v1")

const OrderHttpApiLive = HttpApiBuilder.group(
  Api,
  "order",
  (handlers) =>
    Effect.gen(function*() {
      const orderRepository = yield* OrderRepository
      const outboxRepository = yield* OutboxRepository
      const sagaLogRepository = yield* SagaLogRepository

      return handlers.handle(
        "start",
        (
          { headers: { "idempotency-key": idempotencyKey }, payload: { customerId, productId, quantity, totalPrice } }
        ) =>
          Effect.gen(function*() {
            yield* Console.log(
              `[Order Service] Order start ${{ idempotencyKey, customerId, productId, quantity, totalPrice }}`
            )
            // Check if this saga was already started with this idempotency key })
            const existingSaga = yield* sagaLogRepository.findOne({ idempotencyKey })
            if (existingSaga) {
              yield* Console.log(`[Order Service] Saga already processed with key: ${idempotencyKey}`)
              return {
                message: "Saga already initiated",
                orderId: existingSaga.orderId,
                sagaLogId: existingSaga.id,
                success: true
              }
            }
            const sagaLogId = SagaLogId.make(uuidv7())
            yield* Console.log(`\n[Order Service] Starting Saga: ${sagaLogId}`)
            // Execute all writes in a single transaction
            // const { orderId, paymentEventId } = await withTransaction(async (session) => {
            // Initialize Saga Log with idempotency key
            let sagaLog = new SagaLog({
              id: sagaLogId,
              customerId,
              idempotencyKey,
              productId,
              quantity,
              status: "STARTED",
              steps: [
                {
                  compensationStatus: "PENDING",
                  error: null,
                  status: "PENDING",
                  name: "CREATE_ORDER",
                  timestamp: null
                },
                {
                  compensationStatus: "PENDING",
                  error: null,
                  status: "PENDING",
                  name: "PROCESS_PAYMENT",
                  timestamp: null
                },
                {
                  compensationStatus: "PENDING",
                  error: null,
                  status: "PENDING",
                  name: "UPDATE_INVENTORY",
                  timestamp: null
                },
                {
                  compensationStatus: "PENDING",
                  error: null,
                  status: "PENDING",
                  name: "DELIVER_ORDER",
                  timestamp: null
                }
              ],
              totalPrice
            })
            yield* sagaLogRepository.save(sagaLog)
            // Step 1: Create Order
            yield* Console.log(`[Order Service] Executing Step 1: CREATE_ORDER`)
            const order = new Order({
              id: OrderId.make(uuidv7()),
              customerId,
              productId,
              quantity,
              totalPrice,
              sagaLogId,
              status: "CONFIRMED"
            })
            yield* orderRepository.save(order)
            yield* Console.log(`[Order Service] Order created: ${order.id}`)
            // Update saga log
            sagaLog = new SagaLog({
              ...sagaLog,
              orderId: order.id,
              steps: sagaLog.steps.map((step) =>
                step.name === "CREATE_ORDER"
                  ? { ...step, status: "COMPLETED", timestamp: new Date() }
                  : step
              )
            })
            yield* sagaLogRepository.save(sagaLog)
            // Write payment event to Outbox
            yield* Console.log(`[Order Service] Writing payment event to Outbox`)
            const outboxEntry = new Outbox({
              id: OutboxId.make(uuidv7()),
              aggregateId: order.id,
              eventType: "OrderCreated",
              payload: {
                orderId: order.id,
                customerId,
                amount: totalPrice,
                sagaLogId
              },
              targetService: "payment",
              targetEndpoint: "/payments/process-payment",
              isPublished: false
            })
            yield* outboxRepository.save(outboxEntry)
            yield* Console.log(`[Order Service] Payment event written to Outbox: ${outboxEntry.id}`)
            // Update saga log
            sagaLog = new SagaLog({
              ...sagaLog,
              steps: sagaLog.steps.map((step) =>
                step.name === "PROCESS_PAYMENT"
                  ? { ...step, status: "PENDING", timestamp: new Date() }
                  : step
              )
            })
            yield* sagaLogRepository.save(sagaLog)
            // return { orderId, paymentEventId }
            // })
            return {
              message: "Order saga initiated successfully - events queued for processing",
              orderId: order.id,
              sagaLogId,
              success: true
            }
          })
      ).handle(
        "compensate",
        ({ payload: { orderId } }) =>
          Effect.gen(function*() {
            yield* Console.log(`[Order Service] Order compensate ${{ orderId }}`)
            // const order = await Order.findOneAndUpdate(
            //   { orderId },
            //   { status: "COMPENSATED" },
            //   { new: true }
            // )
            let order = yield* orderRepository.findOne({ orderId })
            if (!order) {
              // throw new Error("Order not found")
              return {
                message: "Order not found",
                success: false
              }
            }
            order = new Order({
              ...order,
              status: "COMPENSATED"
            })
            yield* orderRepository.save(order)
            yield* Console.log(`[Order Service] Order compensated: ${orderId}`)

            return {
              data: order,
              message: "Order compensated successfully",
              success: true
            }
          })
      ).handle("get", ({ path: { orderId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Order Service] Order get ${{ orderId }}`
          )
          const order = yield* orderRepository.findOne({ orderId })
          if (!order) {
            // throw new Error("Order not found")
            return {
              message: "Order not found",
              success: false
            }
          }

          return {
            data: order,
            message: "",
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

const ApplicationLayer = OrderHttpApiLive.pipe(
  Layer.provide(
    Layer.provideMerge(
      Layer.mergeAll(
        OrderRepositoryLive,
        OutboxApplicationLayer,
        OutboxRepositoryLive,
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
  Layer.provide(NodeHttpServer.layer(http.createServer, { port: 3001 })),
  gracefulShutdown,
  Layer.launch,
  NodeRuntime.runMain
)
