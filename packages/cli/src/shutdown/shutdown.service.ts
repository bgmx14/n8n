import { Container, Service } from '@n8n/di';
import { type Class, ErrorReporter } from 'n8n-core';
import { Logger } from 'n8n-core';
import { assert, UnexpectedError, UserError } from 'n8n-workflow';

import { LOWEST_SHUTDOWN_PRIORITY, HIGHEST_SHUTDOWN_PRIORITY } from '@/constants';

type HandlerFn = () => Promise<void> | void;
export type ServiceClass = Class<Record<string, HandlerFn>>;

export interface ShutdownHandler {
	serviceClass: ServiceClass;
	methodName: string;
}

/** Error reported when a listener fails to shutdown gracefully */
export class ComponentShutdownError extends UnexpectedError {
	constructor(componentName: string, cause: Error) {
		super('Failed to shutdown gracefully', {
			cause,
			extra: { component: componentName },
		});
	}
}

/** Service responsible for orchestrating a graceful shutdown of the application */
@Service()
export class ShutdownService {
	private readonly handlersByPriority: ShutdownHandler[][] = [];

	private shutdownPromise: Promise<void> | undefined;

	constructor(
		private readonly logger: Logger,
		private readonly errorReporter: ErrorReporter,
	) {}

	/** Registers given listener to be notified when the application is shutting down */
	register(priority: number, handler: ShutdownHandler) {
		if (priority < LOWEST_SHUTDOWN_PRIORITY || priority > HIGHEST_SHUTDOWN_PRIORITY) {
			throw new UserError(
				`Invalid shutdown priority. Please set it between ${LOWEST_SHUTDOWN_PRIORITY} and ${HIGHEST_SHUTDOWN_PRIORITY}.`,
				{ extra: { priority } },
			);
		}

		if (!this.handlersByPriority[priority]) {
			this.handlersByPriority[priority] = [];
		}
		this.handlersByPriority[priority].push(handler);
	}

	/** Validates that all the registered shutdown handlers are properly configured */
	validate() {
		const handlers = this.handlersByPriority.flat();

		for (const { serviceClass, methodName } of handlers) {
			if (!Container.has(serviceClass)) {
				throw new UserError(
					`Component "${serviceClass.name}" is not registered with the DI container. Any component using @OnShutdown() must be decorated with @Service()`,
				);
			}

			const service = Container.get(serviceClass);
			if (!service[methodName]) {
				throw new UserError(
					`Component "${serviceClass.name}" does not have a "${methodName}" method`,
				);
			}
		}
	}

	/** Signals all registered listeners that the application is shutting down */
	shutdown() {
		if (this.shutdownPromise) {
			throw new UnexpectedError('App is already shutting down');
		}

		this.shutdownPromise = this.startShutdown();
	}

	/** Returns a promise that resolves when all the registered listeners have shut down */
	async waitForShutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			throw new UnexpectedError('App is not shutting down');
		}

		await this.shutdownPromise;
	}

	isShuttingDown() {
		return !!this.shutdownPromise;
	}

	private async startShutdown() {
		const handlers = Object.values(this.handlersByPriority).reverse();
		for (const handlerGroup of handlers) {
			await Promise.allSettled(
				handlerGroup.map(async (handler) => await this.shutdownComponent(handler)),
			);
		}
	}

	private async shutdownComponent({ serviceClass, methodName }: ShutdownHandler) {
		const name = `${serviceClass.name}.${methodName}()`;
		try {
			this.logger.debug(`Shutting down component "${name}"`);
			const service = Container.get(serviceClass);
			const method = service[methodName];
			await method.call(service);
		} catch (error) {
			assert(error instanceof Error);
			this.errorReporter.error(new ComponentShutdownError(name, error));
		}
	}
}
