import type { DiscriminatingOr } from '../utils/typeUtils';
import type Buffer from '../buffer/Buffer';
import ContextConsumer, { WithContext } from '../abstracts/ContextConsumer';
import { devLog } from '../utils/log';
import SyncableBuffer from '../buffer/SyncableBuffer';
import { GeometryDrawMode } from './geometryEnums';
import {
	BufferBindingPoint,
	BufferDataType,
	BufferUsage,
	byteLengthPerMember,
} from '../buffer/bufferEnums';


type SharedAttributeInfo = {
	/** Number of components per vertex. E.g. `4` for a `vec4` */
	size: number;

	/** Enum specifying the type of buffer/data provided. */
	type: BufferDataType;

	/**
	 * Offset in bytes between the beginning of consecutive vertex attributes.
	 *
	 * If `0`, no padding between vertices is assumed, i.e.
	 * `stride` will be equal to the byte length of `type` multiplied by `size`.
	 *
	 * @defaultValue 0
	 */
	stride?: number;

	/**
	 * Start-offset in bytes of the first vertex. Must be a multiple of `type`s byte length.
	 *
	 * @defaultValue 0
	 */
	offset?: number;
};

type AttributeDataInfo = DiscriminatingOr<{
	/** Buffer containing the vertex attribute data. */
	buffer: Buffer;
}, {
	/** ArrayBufferView containing the vertex attribute data. */
	data: ArrayBufferView;

	/**
	 * Whether the attribute data will be updated in the future.
	 *
	 * @defaultValue false
	 */
	dynamic?: boolean;
}>;

type AttributeDeclaration =
SharedAttributeInfo & AttributeDataInfo;


type InternalAttributeInfo = Required<SharedAttributeInfo> & {
	index: number;
	buffer: Buffer;
};


type IndicesDeclaration = {
	/** Enum specifying the type of buffer/data provided. */
	type: BufferDataType.unsignedByte | BufferDataType.unsignedShort | BufferDataType.unsignedInt;
} & AttributeDataInfo;


/**
 * @public
 */
export interface GeometryProps extends WithContext {
	/** Object of vertex attribute declarations, the `key` being the attribute index. */
	attributes: Record<number, AttributeDeclaration>;

	/** Object declaring the vertex indices to use. */
	indices?: IndicesDeclaration,

	/**
	 * How the geometry should be drawn.
	 *
	 * @defaultValue GeometryDrawMode.triangles
	 */
	mode?: GeometryDrawMode;
}


/**
 * Drawable geometry with multiple vertex attributes.
 *
 * @public
 * @example
 * ```typescript
 * import { Geometry } from '@gdgt/webgl';
 *
 * const geometry = new Geometry( {
 *     attributes: {
 *        0: {
 *            data: new Float32Array([-1, 1, 0, -1, -1, 0, 1, -1, 0, 1, 1, 0]),
 *            type: BufferDataType.float,
 *            size: 3,
 *        },
 *        2: {
 *            data: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
 *            type: BufferDataType.float,
 *            size: 2,
 *        },
 *     },
 *     indices: {
 *         data: new Uint16Array([0, 1, 2, 2, 3, 0]),
 *         type: BufferDataType.unsignedShort,
 *     },
 * } );
 *
 * // you can now upload all geometry buffers...
 * await geometry.upload();
 *
 * // ...and draw the geometry afterwards.
 * someProgram.use();
 * geometry.draw();
 * ```
 */
export default class Geometry<T extends GeometryProps = GeometryProps> extends ContextConsumer {
	private vao: WebGLVertexArrayObject;
	private attributeInfo: InternalAttributeInfo[];
	private indicesInfo: { buffer: Buffer, type: IndicesDeclaration['type'] };
	private primitiveCount: number;
	private mode: GeometryDrawMode;

	/** The underlying attribute buffers. */
	public readonly attributes: {
		[key in keyof T['attributes']]:
		// only newly created attributes or ones declared with a syncable buffer
		// are represented by a SyncableBuffer
		T['attributes'][key] extends { buffer: SyncableBuffer } | { data: ArrayBufferView }
			? SyncableBuffer
			: Buffer
	};

	/**
	 * The underlying index buffer.
	 *
	 * Only present if indices were declared on initialization.
	 */
	public readonly indices: T['indices'] extends { buffer: SyncableBuffer } | { data: ArrayBufferView }
	// indices declared with a syncable buffer, or one was created
		? SyncableBuffer
		: T['indices'] extends { buffer: Buffer }
		// indices declared with a buffer as data source
			? Buffer
		// no indices declared
			: undefined;


	public constructor( {
		attributes,
		indices,
		mode = GeometryDrawMode.triangles,
		context,
	}: T ) {
		const attrs: Record<number, Buffer> = {};
		const attributeInfo: Geometry['attributeInfo'] = [];
		let primitiveCount: number;
		let indicesInfo: Geometry['indicesInfo'];

		if ( indices ) {
			const indexSize = byteLengthPerMember( indices.type );
			let indicesBuffer: Buffer;

			if ( 'data' in indices ) {
				primitiveCount = indices.data.byteLength / indexSize;
				indicesBuffer = new SyncableBuffer( {
					context,
					target: BufferBindingPoint.elementArrayBuffer,
					usage: indices.dynamic ? BufferUsage.dynamicDraw : BufferUsage.staticDraw,
					data: indices.data.buffer,
				} );
			} else {
				primitiveCount = indices.buffer.size / indexSize;
				indicesBuffer = indices.buffer;
			}

			indicesInfo = {
				buffer: indicesBuffer,
				type: indices.type,
			};
		}

		Object.entries( attributes ).forEach( ([_index, declaration]) => {
			const index = parseInt( _index, 10 );
			const {
				size,
				type,
				stride = 0,
				offset = 0,
			} = declaration;
			let buffer: Buffer;

			if ( 'data' in declaration ) {
				buffer = new SyncableBuffer( {
					context,
					target: BufferBindingPoint.arrayBuffer,
					usage: declaration.dynamic ? BufferUsage.dynamicDraw : BufferUsage.staticDraw,
					data: declaration.data.buffer,
				} );
			} else {
				buffer = declaration.buffer;
			}

			if ( !primitiveCount ) {
				primitiveCount = Math.floor(
					(
						buffer.size - offset
					) / (
						stride || byteLengthPerMember( type ) * size
					),
				);
			}

			attrs[index] = buffer;
			attributeInfo.push( {
				index,
				buffer,
				size,
				type,
				stride,
				offset,
			} );
		} );

		super( async () => {
			const { gl } = this;

			this.vao = gl.createVertexArray();
			// this is a lot of work to run on construction,
			// there should be a way of controlling the exact timing.
			await this.buildVao( attributeInfo );
		}, context );

		this.indicesInfo = indicesInfo;

		this.attributes = attrs as Record<keyof T['attributes'], SyncableBuffer>;
		this.attributeInfo = attributeInfo;

		this.mode = mode;
		this.primitiveCount = primitiveCount;
	}


	/**
	 * Calls `upload()` on all attribute buffers and the index buffer.
	 */
	public async upload(): Promise<void> {
		const { attributeInfo, indicesInfo } = this;

		if ( indicesInfo && indicesInfo.buffer instanceof SyncableBuffer ) {
			await indicesInfo.buffer.upload();
		}

		await Promise.all( attributeInfo.map( ( attr ) => {
			if ( attr.buffer instanceof SyncableBuffer ) {
				return attr.buffer.upload();
			}

			return Promise.resolve();
		} ) );
	}


	// this should only be run in the constructor, otherwise this.ready
	// will trigger before the VAO is actually built.
	private async buildVao( attributeInfo: Geometry['attributeInfo']): Promise<void> {
		const { gl, vao, indicesInfo } = this;
		// we need sync access to all buffers
		const buffers = await Promise.all(
			attributeInfo.map( ( { buffer } ) => buffer.getBuffer() ),
		);

		let indicesBuffer;

		if ( indicesInfo ) {
			indicesBuffer = await indicesInfo.buffer.getBuffer();
		}

		gl.bindVertexArray( vao );

		if ( indicesBuffer ) {
			gl.bindBuffer( gl.ELEMENT_ARRAY_BUFFER, indicesBuffer );
		}

		attributeInfo.forEach( ( attribute, i ) => {
			const {
				index, size, type, stride, offset,
			} = attribute;

			gl.bindBuffer( gl.ARRAY_BUFFER, buffers[i]);
			gl.enableVertexAttribArray( index );

			switch ( type ) {
				case BufferDataType.byte:
				case BufferDataType.unsignedByte:
				case BufferDataType.short:
				case BufferDataType.unsignedShort:
				case BufferDataType.int:
				case BufferDataType.unsignedInt:
					gl.vertexAttribIPointer( index, size, type, stride, offset );
					break;

				case BufferDataType.float:
				case BufferDataType.halfFloat:
					gl.vertexAttribPointer( index, size, type, false, stride, offset );
					break;

				default:
					throw new Error( 'Invalid buffer data type' );
			}
		} );

		gl.bindVertexArray( null );
	}


	/**
	 * Once ready, returns the underlying VertexArrayObject.
	 *
	 * @returns The underlying VertexArrayObject.
	 */
	public async getVao(): Promise<WebGLVertexArrayObject> {
		await this.ready;

		return this.vao;
	}


	/**
	 * Draws the geometry.
	 *
	 * @returns `true` if the geometry has been successfully drawn, `false` otherwise.
	 */
	public draw(): boolean {
		const {
			gl, vao, mode, primitiveCount, indicesInfo,
		} = this;

		if ( !vao ) {
			if ( __DEV_BUILD__ ) {
				devLog( {
					msg: `Trying to draw geometry that ${
						vao === null ? 'has been deleted' : 'is uninitialized'
					}. This is a noop.`,
				} );
			}

			return false;
		}

		gl.bindVertexArray( vao );

		if ( indicesInfo ) {
			gl.drawElements( mode, primitiveCount, indicesInfo.type, 0 );
		} else {
			gl.drawArrays( mode, 0, primitiveCount );
		}

		gl.bindVertexArray( null );

		return true;
	}


	/**
	 * Flags the underlying VAO and all attribute buffers for deletion.
	 * The geometry cannot be used afterwards.
	 */
	public async delete(): Promise<void> {
		await this.ready;

		const { gl, vao } = this;

		gl.deleteVertexArray( vao );
		this.vao = null;

		await Promise.all(
			this.attributeInfo.map( ( { buffer } ) => buffer.delete() ),
		);
	}
}
