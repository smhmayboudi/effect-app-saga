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
import { SagaLog, SagaLogId } from "./SagaLog.js"

export const ShippingId = Schema.UUID.pipe(
  Schema.brand("ShippingId"),
  Schema.annotations({ description: "Shipping Identification" })
)
export type ShippingId = typeof ShippingId.Type

export const ShippingSchema = Schema.Struct({
  customerId: CustomerId,
  idempotencyKey: IdempotencyKey,
  orderId: OrderId,
  sagaLogId: SagaLogId,
  shippingId: ShippingId,
  status: Schema.optionalWith(
    Schema.Literal("PENDING", "SHIPPED", "DELIVERED", "CANCELLED"),
    { default: () => "PENDING" }
  ).annotations({ description: "Status" }),
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" }),
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "Shipping", identifier: "Shipping" })
)
export type ServiceSchema = typeof ShippingSchema.Type

export class Shipping extends Schema.Class<Shipping>("Shipping")(ShippingSchema) {
  static decodeUnknown = Schema.decodeUnknown(Shipping)
}

export const ShippingDeliverRequest = Schema.Struct({
  customerId: CustomerId,
  orderId: OrderId,
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Shipping Deliver Request", identifier: "ShippingDeliverRequest" })
)
export type ShippingDeliverRequest = typeof ShippingDeliverRequest.Type

export const ShippingCancelRequest = Schema.Struct({
  orderId: OrderId,
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Shipping Cancel Request", identifier: "ShippingCancelRequest" })
)
export type ShippingCancelRequest = typeof ShippingCancelRequest.Type

export class ShippingHttpApiGroup extends HttpApiGroup.make("shipping")
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

export const Api = HttpApi.make("api")
  .add(ShippingHttpApiGroup)

export const ShippingHttpApiLive = HttpApiBuilder.group(
  Api,
  "shipping",
  (handlers) => {
    return handlers.handle(
      "deliver",
      ({ headers: { "idempotency-key": idempotencyKey }, payload: { customerId, orderId, sagaLogId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Shipping Service] Shipping deliver ${{ idempotencyKey, customerId, orderId, sagaLogId }}`
          )
          // Check if shipping already created
          const existingShipping = await Shipping.findOne({ idempotencyKey })
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
          const sagaLog = await SagaLog.findOne({ sagaLogId })

          if (!sagaLog) {
            // throw new Error("Saga not found")
            return {
              message: "Saga not found",
              success: false
            }
          }

          // Execute shipping creation and saga completion without transaction
          // try {
          const shipping = new Shipping({
            shippingId: ShippingId.make(uuidv7()),
            idempotencyKey,
            orderId,
            customerId,
            status: "SHIPPED",
            sagaLogId
          })

          await shipping.save()
          yield* Console.log(`[Shipping Service] Shipping created: ${orderId}`)

          // Update saga log
          const shippingStep = sagaLog.steps.find((s) => s.stepName === "DELIVER_ORDER")
          if (shippingStep) {
            shippingStep.status = "IN_PROGRESS"
            shippingStep.timestamp = new Date()
            await sagaLog.save()

            yield* Console.log(`[Shipping Service] Order delivered: ${orderId}`)

            // Mark saga as completed
            shippingStep.status = "COMPLETED"
            sagaLog.status = "COMPLETED"
            await sagaLog.save()

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
          if (await Shipping.findOne({ compensationKey: idempotencyKey, orderId })) {
            console.log(`[Shipping Service] Shipping already cancelled with key: ${idempotencyKey}`)
            return {
              success: true,
              message: "Shipping already cancelled"
            }
          }

          const shipment = await Shipping.findOneAndUpdate(
            { orderId, sagaLogId },
            {
              status: "CANCELLED",
              compensationKey: idempotencyKey
            },
            { new: true }
          )

          if (!shipment) {
            // throw new Error("Shipping not found")
            return {
              message: "Shipping not found",
              success: false
            }
          }

          yield* Console.log(`[Shipping Service] Shipping cancelled: ${orderId}`)

          return {
            data: shipment,
            message: "Shipping cancelled successfully",
            success: true
          }
        })
    ).handle("get", ({ path: { shippingId } }) =>
      Effect.gen(function*() {
        yield* Console.log(
          `[Shipping Service] Shipping get ${{ shippingId }}`
        )
        const shipping = await Shipping.findOne({ shippingId })

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
  }
)

export const ApiLive = HttpApiBuilder.api(Api)
  .pipe(Layer.provide(ShippingHttpApiLive))

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
