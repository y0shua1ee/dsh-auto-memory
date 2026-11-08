interface StringSchema {
  default(value: string): StringSchema;
}

interface NumberSchema {
  step(value: number): NumberSchema;
  min(value: number): NumberSchema;
  default(value: number): NumberSchema;
}

interface BooleanSchema {
  default(value: boolean): BooleanSchema;
}

interface ArraySchema {
  default(value: string[]): ArraySchema;
}

interface SchemaFactory {
  string(): StringSchema;
  number(): NumberSchema;
  boolean(): BooleanSchema;
  array(item: unknown): ArraySchema;
  object(shape: Record<string, unknown>): unknown;
}

declare const z: SchemaFactory;

export default z;
