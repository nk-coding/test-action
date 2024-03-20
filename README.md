# GraphQL Schema Transform
Normalizes federation subgraph schemas to be valid GraphQL schemas

## Inputs

## `schema`

**Required** The GraphQL schema file to transform

## `target`

**Required** The target for the transformed file

## Example usage

```yml
uses: misarch/graphql-schema-transform@v1
with:
  schema: schema.graphql
  target: transformed.graphql
```