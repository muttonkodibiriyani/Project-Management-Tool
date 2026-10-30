import { Type } from '@fastify/type-provider-typebox';

export const Id = Type.String({ format: 'uuid' });
export const DateOnly = Type.String({ format: 'date' });
export const Limit = (fallback: number) => Type.Integer({ minimum: 1, maximum: 500, default: fallback });
export const Values = Type.Record(Type.String(), Type.Unknown());
export const Ws = Type.Object({ ws: Type.String() });
export const WsId = Type.Object({ ws: Type.String(), id: Id });
