import { ApolloServer, BaseContext } from "@apollo/server";

class ApolloServerSingleton {
	private static instance: ApolloServerSingleton;
	private server: ApolloServer;

	private constructor(typeDefs: any, resolvers: any) {
		this.server = new ApolloServer({
			typeDefs,
			resolvers,
		});
	}

	public static async getInstance({
		typeDefs,
		resolvers,
	}: {
		typeDefs: any;
		resolvers: any;
	}): Promise<ApolloServer> {
		if (!this.instance) {
			this.instance = new ApolloServerSingleton(typeDefs, resolvers);
			await this.instance.server.start();
		}
		return this.instance.server;
	}
}

export const getGQLserver = async ({
	typeDefs,
	resolvers,
}: {
	typeDefs: any;
	resolvers: any;
}) => {
	const apolloServer: ApolloServer<BaseContext> =
		await ApolloServerSingleton.getInstance({
			typeDefs,
			resolvers,
		});
	return apolloServer;
};
