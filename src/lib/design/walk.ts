import type { DesignJson, DesignObject } from "./types";

export interface WalkEntry {
  object: DesignObject;
  index: number;
  path: string;
  parent?: DesignObject;
}

export function walkDesignObjects(
  designOrObjects: DesignJson | DesignObject[] | null | undefined,
  visitor: (entry: WalkEntry) => void
): void {
  const roots = Array.isArray(designOrObjects)
    ? designOrObjects
    : Array.isArray(designOrObjects?.objects)
      ? designOrObjects.objects
      : [];

  const walk = (objects: DesignObject[], parent: DesignObject | undefined, prefix: string) => {
    for (let index = 0; index < (objects || []).length; index += 1) {
      const object = objects[index];
      const path = prefix ? `${prefix}.${index}` : `${index}`;
      visitor({ object, index, path, parent });
      if (Array.isArray(object?.objects)) walk(object.objects, object, path);
    }
  };

  walk(roots, undefined, "");
}
