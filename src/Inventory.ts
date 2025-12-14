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
import { IdempotencyKey } from "./IdempotencyKey.js"
import { OrderId } from "./Order.js"
import { Outbox } from "./Outbox.js"
import { ProductId } from "./Product.js"
import { SagaLogId } from "./SagaLog.js"

export const InventorySchemaStruct = Schema.Struct({
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  reservedQuantity: Schema.optionalWith(Schema.Number.annotations({ description: "Reserved Quantity" }), {
    default: () => 0
  })
  // createdAt: Schema.optionalWith(Schema.Date, { default: () => new Date() }).annotations({ description: "Created At" })
  // updatedAt: Schema.Date.annotations({ description: "Updated At" }),
  // deletedAt: Schema.NullOr(Schema.Date).annotations({ description: "Delete At" })
}).pipe(
  Schema.annotations({ description: "InventoryData", identifier: "InventoryData" })
)
export type InventorySchemaStruct = typeof InventorySchemaStruct.Type

export class Inventory extends Schema.Class<Inventory>("Inventory")(InventorySchemaStruct) {
  static decodeUnknown = Schema.decodeUnknown(InventorySchemaStruct)
}

export const InventoryUpdateRequest = Schema.Struct({
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Inventory Update Request", identifier: "InventoryUpdateRequest" })
)
export type InventoryUpdateRequest = typeof InventoryUpdateRequest.Type

export const InventoryCompensateRequest = Schema.Struct({
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" }),
  sagaLogId: SagaLogId
}).pipe(
  Schema.annotations({ description: "Inventory Compensate Request", identifier: "InventoryCompensateRequest" })
)
export type InventoryCompensateRequest = typeof InventoryCompensateRequest.Type

export const InventoryInitializeRequest = Schema.Struct({
  productId: ProductId,
  quantity: Schema.Number.annotations({ description: "Quantity" })
}).pipe(
  Schema.annotations({ description: "Inventory Compensate Request", identifier: "InventoryInitializeRequest" })
)
export type InventoryInitializeRequest = typeof InventoryInitializeRequest.Type

export class InventoryHttpApiGroup extends HttpApiGroup.make("inventory")
  .add(
    HttpApiEndpoint.post("update", "/update")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(InventoryUpdateRequest)
      .annotate(OpenApi.Description, "Inventory Update")
      .annotate(OpenApi.Summary, "Inventory Update")
  )
  .add(
    HttpApiEndpoint.post("compensate", "/compensate")
      .addSuccess(Schema.Struct({}))
      .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(InventoryCompensateRequest)
      .annotate(OpenApi.Description, "Inventory Compensate")
      .annotate(OpenApi.Summary, "Inventory Compensate")
  )
  .add(
    HttpApiEndpoint.post("initialize", "/initialize")
      .addSuccess(Schema.Struct({}))
      // .setHeaders(Schema.Struct({ "idempotency-key": IdempotencyKey }))
      .setPayload(InventoryInitializeRequest)
      .annotate(OpenApi.Description, "Inventory Compensate")
      .annotate(OpenApi.Summary, "Inventory Compensate")
  )
  .add(
    HttpApiEndpoint.get("get", "/:productId")
      .addSuccess(Schema.Struct({}))
      .setPath(Schema.Struct({ productId: ProductId }))
      .annotate(OpenApi.Description, "Inventory Get")
      .annotate(OpenApi.Summary, "Inventory Get")
  )
  .annotate(OpenApi.Description, "Manage Inventory")
  .annotate(OpenApi.Summary, "Manage Inventory")
  .annotate(OpenApi.Title, "Inventory")
  .prefix("/inventory")
{}

export const Api = HttpApi.make("api")
  .add(InventoryHttpApiGroup)

export const InventoryHttpApiLive = HttpApiBuilder.group(
  Api,
  "inventory",
  (handlers) => {
    return handlers.handle(
      "update",
      ({ headers: { "idempotency-key": idempotencyKey }, payload: { orderId, productId, quantity, sagaLogId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Inventory Service] Inventory update ${{ orderId, productId, quantity, sagaLogId }}`
          )
          const existingInventoryLog = await Inventory.findOne({
            lastIdempotencyKey: idempotencyKey
          })
          if (existingInventoryLog) {
            yield* Console.log(`[Inventory Service] Inventory already updated with key: ${idempotencyKey}`)
            return {
              data: existingInventoryLog,
              message: "Inventory already updated",
              success: true
            }
          }

          // Get saga log to track progress
          const sagaLog = await SagaLog.findOne({ sagaLogId })

          // Execute inventory update without transaction
          let inventory = await Inventory.findOne({ productId })
          if (!inventory) {
            // Initialize inventory with default stock of 100 units
            inventory = new Inventory({
              productId,
              quantity: 100,
              reservedQuantity: 0
            })
            await inventory.save()
            yield* Console.log(`[Inventory Service] Initialized inventory for product ${productId} with 100 units`)
          }

          // Update saga log
          const inventoryStep = sagaLog.steps.find((s) => s.stepName === "UPDATE_INVENTORY")
          inventoryStep.status = "IN_PROGRESS"
          inventoryStep.timestamp = new Date()
          await sagaLog.save()

          // Check if there's enough inventory
          if (inventory.quantity - inventory.reservedQuantity < quantity) {
            console.log(`[Inventory Service] Insufficient inventory for product: ${productId}`)

            // Update saga log
            inventoryStep.status = "FAILED"
            inventoryStep.error = "Insufficient inventory"
            await sagaLog.save()

            // throw new Error("Insufficient inventory")
            return {
              error: "Insufficient inventory",
              message: "Error updating inventory",
              success: false
            }
          }

          // Update inventory - reduce available quantity and increase reserved
          inventory.quantity -= quantity
          inventory.reservedQuantity += quantity
          inventory.lastIdempotencyKey = idempotencyKey
          await inventory.save()

          yield* Console.log(`[Inventory Service] Inventory updated for product: ${productId}`)

          // Update saga log
          inventoryStep.status = "COMPLETED"
          await sagaLog.save()

          // Write shipping event to Outbox
          yield* Console.log(`[Inventory Service] Writing shipping event to Outbox`)

          const shippingEventId = uuidv7()
          const outboxEntry = new Outbox({
            eventId: shippingEventId,
            aggregateId: OrderId.make(orderId.toString()),
            eventType: "InventoryUpdated",
            payload: {
              customerId: sagaLog.customerId || "unknown",
              orderId,
              sagaLogId
            },
            targetService: "shipping",
            targetEndpoint: "/shipments/deliver-order",
            published: false
          })

          await outboxEntry.save()
          yield* Console.log(`[Inventory Service] Shipping event written to Outbox: ${shippingEventId}`)
          yield* Console.log(`[Inventory Service] Saga will be completed when Shipping processes event\n`)

          return { inventory, outboxEntry }
        })
    ).handle(
      "compensate",
      ({ headers: { "idempotency-key": idempotencyKey }, payload: { orderId, productId, quantity, sagaLogId } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Inventory Service] Inventory compensate ${{ orderId, productId, quantity, sagaLogId }}`
          )
          // Check if already compensated
          const inventoryC = await Inventory.findOne({ compensationKey: idempotencyKey, orderId })
          if (inventoryC) {
            yield* Console.log(`[Inventory Service] Inventory already compensated with key: ${idempotencyKey}`)
            return {
              message: "Inventory already compensated",
              success: true
            }
          }

          const inventory = await Inventory.findOne({ productId })
          if (!inventory) {
            // throw new Error("Inventory not found")
            return {
              message: "Inventory not found",
              success: false
            }
          }

          // Restore inventory
          inventory.quantity += quantity
          inventory.reservedQuantity = Math.max(0, inventory.reservedQuantity - quantity)
          inventory.compensationKey = idempotencyKey
          await inventory.save()

          yield* Console.log(`[Inventory Service] Inventory compensated for product: ${productId}`)

          return {
            data: inventory,
            message: "Inventory compensated successfully",
            success: true
          }
        })
    ).handle(
      "initialize",
      ({ payload: { productId, quantity } }) =>
        Effect.gen(function*() {
          yield* Console.log(
            `[Inventory Service] Inventory initialize ${{ productId, quantity }}`
          )
          let inventory = await Inventory.findOne({ productId })

          if (!inventory) {
            inventory = new Inventory({
              productId,
              quantity,
              reservedQuantity: 0
            })
          } else {
            inventory.quantity += quantity
          }

          await inventory.save()

          return {
            data: inventory,
            message: "Inventory initialized",
            success: true
          }
        })
    ).handle("get", ({ path: { productId } }) =>
      Effect.gen(function*() {
        yield* Console.log(
          `[Inventory Service] Inventory initialize ${{ productId }}`
        )
        const inventory = await Inventory.findOne({ productId })

        if (!inventory) {
          // throw new Error("Inventory not found")
          return {
            message: "Inventory not found",
            success: false
          }
        }

        return {
          data: inventory,
          message: "",
          success: true
        }
      }))
  }
)

export const ApiLive = HttpApiBuilder.api(Api)
  .pipe(Layer.provide(InventoryHttpApiLive))

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
