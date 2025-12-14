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
import { EventId, Outbox } from "./Outbox.js"
import { ProductId } from "./Product.js"
import { SagaLog, SagaLogId } from "./SagaLog.js"

export const OrderId = Schema.UUID.pipe(
  Schema.brand("OrderId"),
  Schema.annotations({ description: "Order Identification" })
)
export type OrderId = typeof OrderId.Type

export const OrderSchema = Schema.Struct({
  orderId: OrderId,
  customerId: CustomerId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" }),
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "CONFIRMED", "FAILED", "COMPENSATED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" }),
  sagaLogId: SagaLogId
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Order", identifier: "Order" })
)
export type ServiceSchema = typeof OrderSchema.Type

export class Order extends Schema.Class<Order>("Order")(OrderSchema) {
  static decodeUnknown = Schema.decodeUnknown(Order)
}

export const OrderStartRequest = Schema.Struct({
  customerId: CustomerId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  totalPrice: Schema.Number.annotations({ description: "Total Price" })
}).pipe(
  Schema.annotations({ description: "Order Start Request", identifier: "OrderStartRequest" })
)
export type OrderStartRequest = typeof OrderStartRequest.Type

export const OrderCompensateRequest = Schema.Struct({
  orderId: OrderId
}).pipe(
  Schema.annotations({ description: "Order Compensate Request", identifier: "OrderCompensateRequest" })
)
export type OrderCompensateRequest = typeof OrderCompensateRequest.Type

export class OrderHttpApiGroup extends HttpApiGroup.make("order")
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

export const Api = HttpApi.make("api")
  .add(OrderHttpApiGroup)

export const OrderHttpApiLive = HttpApiBuilder.group(
  Api,
  "order",
  (handlers) => {
    return handlers.handle(
      "start",
      ({ headers: { "idempotency-key": idempotencyKey }, payload: { customerId, productId, quantity, totalPrice } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Order Service] Order start ${{ idempotencyKey, customerId, productId, quantity, totalPrice }}`
          )
          // Check if this saga was already started with this idempotency key
          const existingSaga = await SagaLog.findOne({ idempotencyKey })
          if (existingSaga) {
            yield* Console.log(`[Order Service] Saga already processed with key: ${idempotencyKey}`)
            return {
              message: "Saga already initiated",
              orderId: existingSaga.orderId,
              sagaId: existingSaga.sagaId,
              success: true
            }
          }

          const sagaLogId = SagaLogId.make(uuidv7())
          yield* Console.log(`\n[Order Service] Starting Saga: ${sagaLogId}`)

          // Execute all writes in a single transaction
          const { orderId, paymentEventId } = await withTransaction(async (session) => {
            // Initialize Saga Log with idempotency key
            const sagaLog = new SagaLog({
              sagaLogId,
              idempotencyKey,
              status: "STARTED",
              customerId,
              productId,
              quantity,
              totalPrice,
              steps: [
                {
                  stepName: "CREATE_ORDER",
                  status: "PENDING",
                  timestamp: null,
                  error: null,
                  compensationStatus: "PENDING"
                },
                {
                  stepName: "PROCESS_PAYMENT",
                  status: "PENDING",
                  timestamp: null,
                  error: null,
                  compensationStatus: "PENDING"
                },
                {
                  stepName: "UPDATE_INVENTORY",
                  status: "PENDING",
                  timestamp: null,
                  error: null,
                  compensationStatus: "PENDING"
                },
                {
                  stepName: "DELIVER_ORDER",
                  status: "PENDING",
                  timestamp: null,
                  error: null,
                  compensationStatus: "PENDING"
                }
              ]
            })

            await sagaLog.save({ session })

            // Step 1: Create Order
            yield* Console.log(`[Order Service] Executing Step 1: CREATE_ORDER`)
            const orderId = OrderId.make(uuidv7())
            const order = new Order({
              orderId,
              customerId,
              productId,
              quantity,
              totalPrice,
              sagaLogId,
              status: "CONFIRMED"
            })

            await order.save({ session })
            yield* Console.log(`[Order Service] Order created: ${orderId}`)

            // Update saga log
            const orderStep = sagaLog.steps.find((s) => s.stepName === "CREATE_ORDER")
            orderStep.status = "COMPLETED"
            orderStep.timestamp = new Date()
            sagaLog.orderId = orderId
            await sagaLog.save({ session })

            // Write payment event to Outbox
            // yield* Console.log(`[Order Service] Writing payment event to Outbox`)

            const paymentEventId = EventId.make(uuidv7())
            const outboxEntry = new Outbox({
              eventId: paymentEventId,
              aggregateId: orderId,
              eventType: "OrderCreated",
              payload: {
                orderId,
                customerId,
                amount: totalPrice,
                sagaLogId
              },
              targetService: "payment",
              targetEndpoint: "/payments/process-payment",
              published: false
            })

            await outboxEntry.save({ session })
            yield* Console.log(`[Order Service] Payment event written to Outbox: ${paymentEventId}`)

            // Update saga log
            const paymentStep = sagaLog.steps.find((s) => s.stepName === "PROCESS_PAYMENT")
            paymentStep.status = "PENDING"
            paymentStep.timestamp = new Date()
            await sagaLog.save({ session })

            return { orderId, paymentEventId }
          })

          return {
            message: "Order saga initiated successfully - events queued for processing",
            orderId,
            sagaLogId,
            success: true
          }
        })
    ).handle(
      "compensate",
      ({ payload: { orderId } }) =>
        Effect.gen(function*() {
          yield* Console.log(`[Order Service] Order compensate ${{ orderId }}`)
          const order = await Order.findOneAndUpdate(
            { orderId },
            { status: "COMPENSATED" },
            { new: true }
          )

          if (!order) {
            // throw new Error("Order not found")
            return {
              message: "Order not found",
              success: false
            }
          }

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
        const order = await Order.findOne({ orderId })

        if (!order) {
          // throw new Error("Order not found")
          return {
            message: "Order not found",
            success: false
          }
        }

        return {
          data: order,
          success: true
        }
      }))
  }
)

export const ApiLive = HttpApiBuilder.api(Api)
  .pipe(Layer.provide(OrderHttpApiLive))

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
  Layer.provide(NodeHttpServer.layer(http.createServer, { port: 3003 })),
  gracefulShutdown,
  Layer.launch,
  NodeRuntime.runMain
)
