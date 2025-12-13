import { Context, Effect, Layer, type Queue, Ref, Schema } from "effect"

export class DatabaseError extends Schema.TaggedError<DatabaseError>("DatabaseError")(
  "DatabaseError",
  {}
  // HttpApiSchema.annotations({ status: 404 })
) {}

interface Database {
  Create(data: unknown): Effect.Effect<void>
  Read(): Effect.Effect<Array<unknown>>
  Update(data: unknown): Effect.Effect<void>
  Delete(data: unknown): Effect.Effect<void>
}

export class DatabaseContext extends Context.Tag("@context/Database")<
  DatabaseContext,
  Database
>() {
  static Live = Layer.effect(
    DatabaseContext,
    Effect.gen(function*() {
      const queue = yield* Ref.make(new Map<string, Queue.Queue<string>>())

      return DatabaseContext.of({
        Create(data: unknown) {
          return Effect.void
        },
        Read() {
          return Effect.succeed([])
        },
        Update(data: unknown) {
          return Effect.void
        },
        Delete(data: unknown) {
          return Effect.void
        }
      })
    })
  )
}
