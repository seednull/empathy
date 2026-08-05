#include "impl_internal.h"

#include "assert.h"
#include "string.h"

static EMPATHY_INLINE uint64_t impl_bytecodeGetBaseTypeSize(Empathy_ValueBaseType base_type)
{
	switch (base_type)
	{
		case EMPATHY_VALUE_BASE_TYPE_UINT8:
		case EMPATHY_VALUE_BASE_TYPE_INT8: return 1;

		case EMPATHY_VALUE_BASE_TYPE_UINT16:
		case EMPATHY_VALUE_BASE_TYPE_INT16: return 2;

		case EMPATHY_VALUE_BASE_TYPE_UINT32:
		case EMPATHY_VALUE_BASE_TYPE_INT32:
		case EMPATHY_VALUE_BASE_TYPE_FLOAT32: return 4;

		case EMPATHY_VALUE_BASE_TYPE_UINT64:
		case EMPATHY_VALUE_BASE_TYPE_INT64:
		case EMPATHY_VALUE_BASE_TYPE_FLOAT64:
		case EMPATHY_VALUE_BASE_TYPE_ATOM: return 8;

		default: assert(0); return UINT64_MAX;
	}
}

static EMPATHY_INLINE uint64_t impl_bytecodeGetInstructionSize(Impl_Opcode opcode)
{
	switch (opcode)
	{
		// constant
		case IMPL_OPCODE_PUSH_U8:
		case IMPL_OPCODE_PUSH_I8: return 2;

		case IMPL_OPCODE_PUSH_U16:
		case IMPL_OPCODE_PUSH_I16: return 3;

		case IMPL_OPCODE_PUSH_U32:
		case IMPL_OPCODE_PUSH_I32:
		case IMPL_OPCODE_PUSH_F32: return 5;

		case IMPL_OPCODE_PUSH_U64:
		case IMPL_OPCODE_PUSH_I64:
		case IMPL_OPCODE_PUSH_F64:
		case IMPL_OPCODE_PUSH_ATOM: return 9;

		// parameter
		case IMPL_OPCODE_LOAD:
		case IMPL_OPCODE_STORE: return 5;

		// stack
		case IMPL_OPCODE_DROP:
		case IMPL_OPCODE_DUP: return 1;

		// arithmetic
		case IMPL_OPCODE_ADD:
		case IMPL_OPCODE_SUB:
		case IMPL_OPCODE_MUL:
		case IMPL_OPCODE_DIV: return 1;

		// logic
		case IMPL_OPCODE_EQUAL:
		case IMPL_OPCODE_NOT_EQUAL:
		case IMPL_OPCODE_LESS:
		case IMPL_OPCODE_LESS_EQUAL:
		case IMPL_OPCODE_GREATER:
		case IMPL_OPCODE_GREATER_EQUAL: return 1;

		// control
		case IMPL_OPCODE_JUMP:
		case IMPL_OPCODE_JUMP_FALSE:
		case IMPL_OPCODE_JUMP_TRUE: return 9;

		// predicate
		case IMPL_OPCODE_REJECT:
		case IMPL_OPCODE_REJECT_FALSE:
		case IMPL_OPCODE_REJECT_TRUE:
		case IMPL_OPCODE_MATCH: return 1;

		// yield
		case IMPL_OPCODE_BEGIN_YIELD: return 1;
		case IMPL_OPCODE_YIELD: return 5;

		// end
		case IMPL_OPCODE_END: return 1;

		default: assert(0); return UINT64_MAX;
	}
}

static EMPATHY_INLINE Impl_OpcodeMode impl_bytecodeGetInstructionMode(Impl_Opcode opcode)
{
	switch (opcode)
	{
		// constant
		case IMPL_OPCODE_PUSH_U8:
		case IMPL_OPCODE_PUSH_U16:
		case IMPL_OPCODE_PUSH_U32:
		case IMPL_OPCODE_PUSH_U64:
		case IMPL_OPCODE_PUSH_I8:
		case IMPL_OPCODE_PUSH_I16:
		case IMPL_OPCODE_PUSH_I32:
		case IMPL_OPCODE_PUSH_I64:
		case IMPL_OPCODE_PUSH_F32:
		case IMPL_OPCODE_PUSH_F64:
		case IMPL_OPCODE_PUSH_ATOM: return IMPL_OPCODE_MODE_BOTH;

		// parameter
		case IMPL_OPCODE_LOAD: return IMPL_OPCODE_MODE_BOTH;
		case IMPL_OPCODE_STORE: return IMPL_OPCODE_MODE_EXECUTION;

		// stack
		case IMPL_OPCODE_DROP:
		case IMPL_OPCODE_DUP: return IMPL_OPCODE_MODE_BOTH;

		// arithmetic
		case IMPL_OPCODE_ADD:
		case IMPL_OPCODE_SUB:
		case IMPL_OPCODE_MUL:
		case IMPL_OPCODE_DIV: return IMPL_OPCODE_MODE_BOTH;

		// logic
		case IMPL_OPCODE_EQUAL:
		case IMPL_OPCODE_NOT_EQUAL:
		case IMPL_OPCODE_LESS:
		case IMPL_OPCODE_LESS_EQUAL:
		case IMPL_OPCODE_GREATER:
		case IMPL_OPCODE_GREATER_EQUAL: return IMPL_OPCODE_MODE_BOTH;

		// control
		case IMPL_OPCODE_JUMP:
		case IMPL_OPCODE_JUMP_FALSE:
		case IMPL_OPCODE_JUMP_TRUE: return IMPL_OPCODE_MODE_BOTH;

		// predicate
		case IMPL_OPCODE_REJECT:
		case IMPL_OPCODE_REJECT_FALSE:
		case IMPL_OPCODE_REJECT_TRUE:
		case IMPL_OPCODE_MATCH: return IMPL_OPCODE_MODE_PREDICATE;

		// yield
		case IMPL_OPCODE_BEGIN_YIELD:
		case IMPL_OPCODE_YIELD: return IMPL_OPCODE_MODE_EXECUTION;

		// end
		case IMPL_OPCODE_END: return IMPL_OPCODE_MODE_EXECUTION;

		default: assert(0); return IMPL_OPCODE_MODE_ENUM_FORCE32;
	}
}

Empathy_Result impl_bytecodeValidate(uint64_t size, const void *data, const Impl_ProgramLayout *layout)
{
	assert(size > 0);
	assert(data);
	assert(layout);

	EMPATHY_UNUSED(layout);

	const uint8_t *bytes = (const uint8_t *)data;

	uint64_t offset = 0;
	while (offset < size)
	{
		uint8_t opcode = bytes[offset];

		if (opcode < IMPL_OPCODE_ENUM_START || opcode > IMPL_OPCODE_ENUM_END)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		uint64_t instruction_size = impl_bytecodeGetInstructionSize(opcode);
		if (offset + instruction_size > size)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		// TODO: validate atoms, address & yield related opcodes

		offset += instruction_size;
	}

	return EMPATHY_SUCCESS;
}

Empathy_Result impl_bytecodeExecute(Impl_ExecutionContext *context, uint32_t budget)
{
	assert(context);

	const Impl_Program *program = context->program;
	assert(program);
	assert(program->data);
	assert(program->size > 0);

	const Impl_ProgramLayout *layout = context->layout;
	assert(layout);

	Impl_MachineStack *stack = &context->stack;
	assert(stack);
	assert(stack->data);
	assert(stack->size > 0);
	assert(stack->head <= stack->size);

	const uint8_t *bytes = (const uint8_t *)program->data;

	for (uint32_t current_budget = 0; current_budget < budget; ++current_budget)
	{
		uint8_t opcode = bytes[context->instruction_pointer];

		if (opcode < IMPL_OPCODE_ENUM_START || opcode > IMPL_OPCODE_ENUM_END)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		uint64_t instruction_size = impl_bytecodeGetInstructionSize(opcode);
		if (context->instruction_pointer + instruction_size > program->size)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		Impl_OpcodeMode mode = impl_bytecodeGetInstructionMode(opcode);
		if ((mode & context->mode) == 0)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		const uint8_t *instruction_data = bytes + context->instruction_pointer + 1;

		switch (opcode)
		{
			case IMPL_OPCODE_PUSH_U8:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				uint8_t data = *(const uint8_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;
				value.data.u8 = data;

				stack->data[stack->head++] = value;
			}
			break;
			
			case IMPL_OPCODE_PUSH_U16:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

					uint16_t data = *(const uint16_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT16;
				value.data.u16 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_U32:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				uint32_t data = *(const uint32_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT32;
				value.data.u32 = data;


				stack->data[stack->head++] = value;

			}
			break;

			case IMPL_OPCODE_PUSH_U64:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				uint64_t data = *(const uint64_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT64;
				value.data.u64 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I8:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				int8_t data = *(const int8_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT8;
				value.data.i8 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I16:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				int16_t data = *(const int16_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT16;
				value.data.i16 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I32:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				int32_t data = *(const int32_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT32;
				value.data.i32 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I64:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				int64_t data = *(const int64_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT64;
				value.data.i64 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_F32:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				float data = *(const float *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_FLOAT32;
				value.data.f32 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_F64:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				double data = *(const double *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_FLOAT64;
				value.data.f64 = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_ATOM:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				Empathy_Atom data = *(const Empathy_Atom *)instruction_data;

				Empathy_Value value = {0};
				value.type = (Empathy_ValueType){EMPATHY_VALUE_BASE_TYPE_ATOM, data.type};
				value.data.atom = data;

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_LOAD:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				uint32_t index = *(const uint32_t *)instruction_data;
				assert(index < layout->num_parameters);

				const Impl_ProgramLayoutParameter *parameter = &layout->parameters[index];
				assert(parameter);

				if ((parameter->access & EMPATHY_PARAMETER_ACCESS_FLAGS_READ) == 0)
					return EMPATHY_PARAMETER_NOT_READABLE;

				uint64_t parameter_offset = parameter->offset;
				uint64_t parameter_size = impl_bytecodeGetBaseTypeSize(parameter->type.base_type);

				assert(parameter->table < context->max_bindings);

				const uint8_t *table = (uint8_t *)context->bindings[parameter->table].data;
				const uint64_t table_size = context->bindings[parameter->table].size;
				assert(table);

				if (parameter_offset + parameter_size > table_size)
					return EMPATHY_PARAMETER_TABLE_OUT_OF_BOUNDS_READ;

				table += parameter_offset;

				Empathy_Value value = {0};
				value.type = parameter->type;

				switch (parameter->type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = *(const uint8_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u16 = *(const uint16_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u32 = *(const uint32_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u64 = *(const uint64_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.i8 = *(const int8_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.i16 = *(const int16_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.i32 = *(const int32_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.i64 = *(const int64_t *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.f32 = *(const float *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.f64 = *(const double *)table; break;
					case EMPATHY_VALUE_BASE_TYPE_ATOM: value.data.atom = *(const Empathy_Atom *)table; break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_STORE:
			{
				if (stack->head == 0)
					return EMPATHY_STACK_UNDERFLOW;

				uint32_t index = *(const uint32_t *)instruction_data;
				assert(index < layout->num_parameters);

				const Impl_ProgramLayoutParameter *parameter = &layout->parameters[index];
				assert(parameter);

				if ((parameter->access & EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE) == 0)
					return EMPATHY_PARAMETER_NOT_WRITABLE;

				Empathy_Value value = stack->data[stack->head - 1];

				if (parameter->type.base_type != value.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				if (parameter->type.atom_type != value.type.atom_type)
					return EMPATHY_ATOM_TYPE_MISMATCH;

				uint64_t parameter_offset = parameter->offset;
				uint64_t parameter_size = impl_bytecodeGetBaseTypeSize(parameter->type.base_type);
				uint64_t value_size = impl_bytecodeGetBaseTypeSize(value.type.base_type);

				assert(value_size == parameter_size);
				assert(parameter->table < context->max_bindings);

				uint8_t *table = (uint8_t *)context->bindings[parameter->table].data;
				uint64_t table_size = context->bindings[parameter->table].size;
				assert(table);

				if (parameter_offset + parameter_size > table_size)
					return EMPATHY_PARAMETER_TABLE_OUT_OF_BOUNDS_WRITE;

				table += parameter_offset;

				switch (parameter->type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: *(uint8_t *)table = value.data.u8; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: *(uint16_t *)table = value.data.u16; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: *(uint32_t *)table = value.data.u32; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: *(uint64_t *)table = value.data.u64; break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: *(int8_t *)table = value.data.i8; break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: *(int16_t *)table = value.data.i16; break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: *(int32_t *)table = value.data.i32; break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: *(int64_t *)table = value.data.i64; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: *(float *)table = value.data.f32; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: *(double *)table = value.data.f64; break;
					case EMPATHY_VALUE_BASE_TYPE_ATOM: *(Empathy_Atom *)table = value.data.atom; break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 1;
			}
			break;

			case IMPL_OPCODE_DROP:
			{
				if (stack->head == 0)
					return EMPATHY_STACK_UNDERFLOW;

				stack->head--;
			}
			break;

			case IMPL_OPCODE_DUP:
			{
				if (stack->head >= stack->size)
					return EMPATHY_STACK_OVERFLOW;

				if (stack->head == 0)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value value = stack->data[stack->head - 1];
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_ADD:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type = a.type;

				switch (value.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = a.data.u8 + b.data.u8; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u16 = a.data.u16 + b.data.u16; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u32 = a.data.u32 + b.data.u32; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u64 = a.data.u64 + b.data.u64; break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.i8 = a.data.i8 + b.data.i8; break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.i16 = a.data.i16 + b.data.i16; break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.i32 = a.data.i32 + b.data.i32; break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.i64 = a.data.i64 + b.data.i64; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.f32 = a.data.f32 + b.data.f32; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.f64 = a.data.f64 + b.data.f64; break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_SUB:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type = a.type;

				switch (value.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = a.data.u8 - b.data.u8; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u16 = a.data.u16 - b.data.u16; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u32 = a.data.u32 - b.data.u32; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u64 = a.data.u64 - b.data.u64; break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.i8 = a.data.i8 - b.data.i8; break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.i16 = a.data.i16 - b.data.i16; break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.i32 = a.data.i32 - b.data.i32; break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.i64 = a.data.i64 - b.data.i64; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.f32 = a.data.f32 - b.data.f32; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.f64 = a.data.f64 - b.data.f64; break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_MUL:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type = a.type;

				switch (value.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = a.data.u8 * b.data.u8; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u16 = a.data.u16 * b.data.u16; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u32 = a.data.u32 * b.data.u32; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u64 = a.data.u64 * b.data.u64; break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.i8 = a.data.i8 * b.data.i8; break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.i16 = a.data.i16 * b.data.i16; break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.i32 = a.data.i32 * b.data.i32; break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.i64 = a.data.i64 * b.data.i64; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.f32 = a.data.f32 * b.data.f32; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.f64 = a.data.f64 * b.data.f64; break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_DIV:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type = a.type;

				switch (value.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = a.data.u8 / b.data.u8; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u16 = a.data.u16 / b.data.u16; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u32 = a.data.u32 / b.data.u32; break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u64 = a.data.u64 / b.data.u64; break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.i8 = a.data.i8 / b.data.i8; break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.i16 = a.data.i16 / b.data.i16; break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.i32 = a.data.i32 / b.data.i32; break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.i64 = a.data.i64 / b.data.i64; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.f32 = a.data.f32 / b.data.f32; break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.f64 = a.data.f64 / b.data.f64; break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_EQUAL:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				if (a.type.atom_type != b.type.atom_type)
					return EMPATHY_ATOM_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;

				switch (a.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = (a.data.u8 == b.data.u8); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u8 = (a.data.u16 == b.data.u16); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u8 = (a.data.u32 == b.data.u32); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u8 = (a.data.u64 == b.data.u64); break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.u8 = (a.data.i8 == b.data.i8); break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.u8 = (a.data.i16 == b.data.i16); break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.u8 = (a.data.i32 == b.data.i32); break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.u8 = (a.data.i64 == b.data.i64); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.u8 = (a.data.f32 == b.data.f32); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.u8 = (a.data.f64 == b.data.f64); break;
					case EMPATHY_VALUE_BASE_TYPE_ATOM: value.data.u8 = (memcmp(&a.data.atom, &b.data.atom, sizeof(Empathy_Atom)) == 0); break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_NOT_EQUAL:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				if (a.type.atom_type != b.type.atom_type)
					return EMPATHY_ATOM_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;

				switch (a.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = (a.data.u8 != b.data.u8); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u8 = (a.data.u16 != b.data.u16); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u8 = (a.data.u32 != b.data.u32); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u8 = (a.data.u64 != b.data.u64); break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.u8 = (a.data.i8 != b.data.i8); break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.u8 = (a.data.i16 != b.data.i16); break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.u8 = (a.data.i32 != b.data.i32); break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.u8 = (a.data.i64 != b.data.i64); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.u8 = (a.data.f32 != b.data.f32); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.u8 = (a.data.f64 != b.data.f64); break;
					case EMPATHY_VALUE_BASE_TYPE_ATOM: value.data.u8 = (memcmp(&a.data.atom, &b.data.atom, sizeof(Empathy_Atom)) != 0); break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_LESS:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;

				switch (a.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = (a.data.u8 < b.data.u8); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u8 = (a.data.u16 < b.data.u16); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u8 = (a.data.u32 < b.data.u32); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u8 = (a.data.u64 < b.data.u64); break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.u8 = (a.data.i8 < b.data.i8); break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.u8 = (a.data.i16 < b.data.i16); break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.u8 = (a.data.i32 < b.data.i32); break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.u8 = (a.data.i64 < b.data.i64); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.u8 = (a.data.f32 < b.data.f32); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.u8 = (a.data.f64 < b.data.f64); break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_LESS_EQUAL:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;

				switch (a.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = (a.data.u8 <= b.data.u8); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u8 = (a.data.u16 <= b.data.u16); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u8 = (a.data.u32 <= b.data.u32); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u8 = (a.data.u64 <= b.data.u64); break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.u8 = (a.data.i8 <= b.data.i8); break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.u8 = (a.data.i16 <= b.data.i16); break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.u8 = (a.data.i32 <= b.data.i32); break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.u8 = (a.data.i64 <= b.data.i64); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.u8 = (a.data.f32 <= b.data.f32); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.u8 = (a.data.f64 <= b.data.f64); break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_GREATER:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;

				switch (a.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = (a.data.u8 > b.data.u8); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u8 = (a.data.u16 > b.data.u16); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u8 = (a.data.u32 > b.data.u32); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u8 = (a.data.u64 > b.data.u64); break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.u8 = (a.data.i8 > b.data.i8); break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.u8 = (a.data.i16 > b.data.i16); break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.u8 = (a.data.i32 > b.data.i32); break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.u8 = (a.data.i64 > b.data.i64); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.u8 = (a.data.f32 > b.data.f32); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.u8 = (a.data.f64 > b.data.f64); break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_GREATER_EQUAL:
			{
				if (stack->head <= 1)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value b = stack->data[stack->head - 1];
				Empathy_Value a = stack->data[stack->head - 2];

				if (a.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (b.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (a.type.base_type != b.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;

				switch (a.type.base_type)
				{
					case EMPATHY_VALUE_BASE_TYPE_UINT8: value.data.u8 = (a.data.u8 >= b.data.u8); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT16: value.data.u8 = (a.data.u16 >= b.data.u16); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT32: value.data.u8 = (a.data.u32 >= b.data.u32); break;
					case EMPATHY_VALUE_BASE_TYPE_UINT64: value.data.u8 = (a.data.u64 >= b.data.u64); break;
					case EMPATHY_VALUE_BASE_TYPE_INT8: value.data.u8 = (a.data.i8 >= b.data.i8); break;
					case EMPATHY_VALUE_BASE_TYPE_INT16: value.data.u8 = (a.data.i16 >= b.data.i16); break;
					case EMPATHY_VALUE_BASE_TYPE_INT32: value.data.u8 = (a.data.i32 >= b.data.i32); break;
					case EMPATHY_VALUE_BASE_TYPE_INT64: value.data.u8 = (a.data.i64 >= b.data.i64); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT32: value.data.u8 = (a.data.f32 >= b.data.f32); break;
					case EMPATHY_VALUE_BASE_TYPE_FLOAT64: value.data.u8 = (a.data.f64 >= b.data.f64); break;
					default: assert(0); return EMPATHY_INTERNAL_ERROR;
				}

				stack->head -= 2;
				stack->data[stack->head++] = value;
			}
			break;

			case IMPL_OPCODE_JUMP:
			{
				uint64_t jump_target = *(const uint64_t *)instruction_data;
				if (jump_target >= program->size)
					return EMPATHY_INVALID_INSTRUCTION_DATA;

				context->instruction_pointer = jump_target;
				instruction_size = 0;
			}
			break;

			case IMPL_OPCODE_JUMP_FALSE:
			{
				uint64_t jump_target = *(const uint64_t *)instruction_data;
				if (jump_target >= program->size)
					return EMPATHY_INVALID_INSTRUCTION_DATA;

				if (stack->head == 0)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value value = stack->data[stack->head - 1];
				if (value.type.base_type != EMPATHY_VALUE_BASE_TYPE_UINT8)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (value.data.u8 == 0)
				{
					context->instruction_pointer = jump_target;
					instruction_size = 0;
				}

				stack->head -= 1;
			}
			break;

			case IMPL_OPCODE_JUMP_TRUE:
			{
				uint64_t jump_target = *(const uint64_t *)instruction_data;
				if (jump_target >= program->size)
					return EMPATHY_INVALID_INSTRUCTION_DATA;

				if (stack->head == 0)
					return EMPATHY_STACK_UNDERFLOW;

				Empathy_Value value = stack->data[stack->head - 1];
				if (value.type.base_type != EMPATHY_VALUE_BASE_TYPE_UINT8)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (value.data.u8 != 0)
				{
					context->instruction_pointer = jump_target;
					instruction_size = 0;
				}

				stack->head -= 1;
			}
			break;

			case IMPL_OPCODE_REJECT:
			{
				return EMPATHY_NOT_IMPLEMENTED;
			}
			break;

			case IMPL_OPCODE_REJECT_FALSE:
			{
				return EMPATHY_NOT_IMPLEMENTED;
			}
			break;

			case IMPL_OPCODE_REJECT_TRUE:
			{
				return EMPATHY_NOT_IMPLEMENTED;
			}
			break;

			case IMPL_OPCODE_MATCH:
			{
				return EMPATHY_NOT_IMPLEMENTED;
			}
			break;

			case IMPL_OPCODE_BEGIN_YIELD:
			{
				return EMPATHY_NOT_IMPLEMENTED;
			}
			break;

			case IMPL_OPCODE_YIELD:
			{
				return EMPATHY_NOT_IMPLEMENTED;
			}
			break;

			case IMPL_OPCODE_END:
			{
				context->instruction_pointer += instruction_size;
				return EMPATHY_EXECUTION_END;
			}
			break;
		}

		context->instruction_pointer += instruction_size;
	}

	return EMPATHY_EXECUTION_BUDGET_EXCEEDED;
}
