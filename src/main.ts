import * as core from "@actions/core"
import {
    DirectiveLocation,
    GraphQLBoolean,
    GraphQLDirective,
    GraphQLList,
    GraphQLNonNull,
    GraphQLScalarType,
    GraphQLUnionType,
    Kind,
    parse,
    GraphQLSchema,
    GraphQLObjectType,
    ConstDirectiveNode,
    ConstArgumentNode
} from "graphql"
import { readFileSync, writeFileSync } from "fs"
import { composeServices } from "@apollo/composition"
import { MapperKind, mapSchema, printSchemaWithDirectives } from "@graphql-tools/utils"

/**
 * The main function for the action, transforms the given supergraph schema
 */
export async function run() {
    try {
        const schemaFile: string = core.getInput("schema")
        const outputFile: string = core.getInput("target")

        const schema = loadSchema(schemaFile)
        const resultSchema = normalizeSchema(schema)

        writeFileSync(outputFile, printSchemaWithDirectives(resultSchema))
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        }
    }
}

/**
 * Transforms a supergraph schema to a federation subgraph schema with is also a valid GraphQL schema
 *
 * @param schema the schema to transform
 * @returns the transformed schema
 */
function normalizeSchema(schema: GraphQLSchema) {
    setFederationSchemaDirective(schema)
    const [schemaWithFederationDirectives, entityNames] = addFederationDirectives(schema)
    const schemaWithoutJoinDirectives = removeJoinDirectivesUsages(schemaWithFederationDirectives)
    const schemaWithoutRootFedDirectives = removeFederationDirectivesFromRootObjects(schemaWithoutJoinDirectives)
    const resultSchema = removeJoinTypes(schemaWithoutRootFedDirectives)
    const anyScalar = new GraphQLScalarType({ name: "_Any" })
    const fieldSetScalar = new GraphQLScalarType({ name: "FieldSet" })
    const entityUnion = new GraphQLUnionType({
        name: "_Entity",
        types: entityNames.map(name => resultSchema.getType(name) as GraphQLObjectType)
    })
    resultSchema.getTypeMap()._Any = anyScalar
    resultSchema.getTypeMap().FieldSet = fieldSetScalar
    resultSchema.getTypeMap()._Entity = entityUnion
    addEntitiesQueryToSchema(resultSchema, entityUnion, anyScalar)
    addFederationDirectivesToSchema(resultSchema, fieldSetScalar)
    return resultSchema
}

/**
 * Adds the _entities query to the schema
 *
 * @param resultSchema the schema to add the _entities query to
 * @param entityUnion the entity union type
 * @param anyScalar the any scalar type
 */
function addEntitiesQueryToSchema(
    resultSchema: GraphQLSchema,
    entityUnion: GraphQLUnionType,
    anyScalar: GraphQLScalarType<unknown, unknown>
) {
    resultSchema.getQueryType().getFields()._entities = {
        name: "_entities",
        type: new GraphQLNonNull(new GraphQLList(entityUnion)),
        args: [
            {
                name: "representations",
                type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(anyScalar))),
                description: undefined,
                defaultValue: undefined,
                extensions: undefined,
                astNode: undefined,
                deprecationReason: undefined
            }
        ],
        description: undefined,
        extensions: undefined,
        astNode: undefined,
        deprecationReason: undefined
    }
}

/**
 * Adds the federation directives to the schema
 *
 * @param resultSchema the schema to add the federation directives to
 * @param fieldSetScalar the field set scalar type
 */
function addFederationDirectivesToSchema(
    resultSchema: GraphQLSchema,
    fieldSetScalar: GraphQLScalarType<unknown, unknown>
) {
    const directives = resultSchema.getDirectives() as GraphQLDirective[]
    directives.push(
        new GraphQLDirective({
            name: "key",
            isRepeatable: true,
            locations: [DirectiveLocation.OBJECT, DirectiveLocation.INTERFACE],
            args: {
                fields: {
                    type: new GraphQLNonNull(fieldSetScalar)
                },
                resolvable: {
                    type: GraphQLBoolean,
                    defaultValue: true
                }
            }
        }),
        new GraphQLDirective({
            name: "shareable",
            isRepeatable: true,
            locations: [DirectiveLocation.OBJECT, DirectiveLocation.FIELD_DEFINITION]
        })
    )
}

/**
 * Sets the federation schema directive on the given schema
 *
 * @param schema the schema to set the federation schema directive on
 */
function setFederationSchemaDirective(schema: GraphQLSchema) {
    schema.astNode = {
        ...schema.astNode,
        directives: [
            {
                kind: Kind.DIRECTIVE,
                name: {
                    kind: Kind.NAME,
                    value: "link"
                },
                arguments: [
                    {
                        kind: Kind.ARGUMENT,
                        name: {
                            kind: Kind.NAME,
                            value: "url"
                        },
                        value: {
                            kind: Kind.STRING,
                            value: "https://specs.apollo.dev/federation/v2.5"
                        }
                    }
                ]
            }
        ]
    }
}

/**
 * Loads the schema from the given file
 *
 * @param schemaFile the file to load the schema from
 * @returns the loaded schema
 * @throws if the schema is invalid or not compatible with the federation spec
 */
function loadSchema(schemaFile: string) {
    const schema = parse(readFileSync(schemaFile, "utf-8"))
    const compositionResult = composeServices([
        {
            name: "service",
            typeDefs: schema
        }
    ])
    if (compositionResult.errors) {
        throw new Error(compositionResult.errors.map(error => error.message).join("\n"))
    }
    const resultSchema = compositionResult.schema.toGraphQLJSSchema()
    return resultSchema
}

/**
 * Adds the federation directives to all object types in the schema
 *
 * @param schema the schema to add the federation directives to
 * @returns the schema with the federation directives added
 */
function addFederationDirectives(schema: GraphQLSchema): [GraphQLSchema, string[]] {
    const entityNames: string[] = []
    const transformnedSchema = mapSchema(schema, {
        [MapperKind.OBJECT_TYPE]: type => {
            const joinTypeDirective = findJoinDirective(type)
            if (joinTypeDirective == undefined) {
                return
            }
            const joinTypeArguments = new Map((joinTypeDirective.arguments ?? []).map(arg => [arg.name.value, arg]))
            const federationDirective = generateFederationDirective(joinTypeArguments)
            if (federationDirective.name.value === "key") {
                entityNames.push(type.name)
            }
            return new GraphQLObjectType({
                ...type.toConfig(),
                astNode: {
                    ...type.astNode,
                    directives: [...type.astNode.directives, federationDirective]
                }
            })
        }
    })
    return [transformnedSchema, entityNames]
}

/**
 * Removes all federation directives from the root objects of the schema
 *
 * @param schema the schema to remove the federation directives from
 * @returns the schema without the federation directives
 */
function removeFederationDirectivesFromRootObjects(schema: GraphQLSchema): GraphQLSchema {
    return mapSchema(schema, {
        [MapperKind.ROOT_OBJECT]: type => {
            return new GraphQLObjectType({
                ...type.toConfig(),
                astNode: {
                    ...type.astNode,
                    directives: []
                }
            })
        }
    })
}

/**
 * Generates the federation directive for a type
 * If the type specifies a key using the join_type directive, the key directive is generated.
 * If the type does not specify a key, the shareable directive is generated.
 *
 * @param joinTypeArguments arguments of the join_type directive
 * @param type the type to generate the federation directive for
 * @returns
 */
function generateFederationDirective(joinTypeArguments: Map<string, ConstArgumentNode>): ConstDirectiveNode {
    if (joinTypeArguments.has("key")) {
        return {
            kind: Kind.DIRECTIVE,
            name: {
                kind: Kind.NAME,
                value: "key"
            },
            arguments: [joinTypeArguments.get("key"), joinTypeArguments.get("resolvable")]
        }
    } else {
        return {
            kind: Kind.DIRECTIVE,
            name: {
                kind: Kind.NAME,
                value: "shareable"
            }
        }
    }
}

/**
 * Finds a join directive on an object type
 *
 * @param type The object type to find the join directive on
 * @returns The join directive if it exists
 */
function findJoinDirective(type: GraphQLObjectType<any, any>) {
    if (type.astNode?.directives == undefined) {
        return undefined
    }
    const directives = type.astNode?.directives ?? []
    return directives.find(directive => directive.name.value === "join__type")
}

/**
 * Removes all join directives from the schema
 *
 * @param schema The schema to remove the join directives from
 * @returns The schema without the join directives
 */
function removeJoinDirectivesUsages(schema: GraphQLSchema): GraphQLSchema {
    return mapSchema(schema, {
        [MapperKind.TYPE]: type => {
            removeJoinDirectives(type)
            return undefined
        },
        [MapperKind.ENUM_VALUE]: valueConfig => {
            removeJoinDirectives(valueConfig)
            return undefined
        }
    })
}

/**
 * Removes all join enum types, scalar types and directives from the schema
 *
 * @param schema The schema to remove the join types from
 * @returns The schema without the join types
 */
function removeJoinTypes(schema: GraphQLSchema): GraphQLSchema {
    return mapSchema(schema, {
        [MapperKind.ENUM_TYPE]: type => {
            if (type.name.startsWith("join__")) {
                return null
            }
            return undefined
        },
        [MapperKind.DIRECTIVE]: directive => {
            if (directive.name.startsWith("join__")) {
                return null
            }
            return directive
        },
        [MapperKind.SCALAR_TYPE]: type => {
            if (type.name.startsWith("join__")) {
                return null
            }
            return undefined
        }
    })
}

/**
 * Removes a join directive from a type
 *
 * @param type The type to remove the join directive from
 * @returns The type without the join directive
 */
function removeJoinDirectives(type) {
    if (type.astNode?.directives == undefined) {
        return
    }
    const directives = type.astNode?.directives ?? []
    const newDirectives = directives.filter(directive => !directive.name.value.startsWith("join__"))
    type.astNode.directives = newDirectives
}
