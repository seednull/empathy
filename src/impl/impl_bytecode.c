#include "impl_internal.h"

#include "assert.h"
#include "string.h"

typedef enum Impl_Opcode_t
{
	IMPL_OPCODE_PUSH_U8 = 0,
	IMPL_OPCODE_PUSH_U16,
	IMPL_OPCODE_PUSH_U32,
	IMPL_OPCODE_PUSH_U64,
	IMPL_OPCODE_PUSH_I8,
	IMPL_OPCODE_PUSH_I16,
	IMPL_OPCODE_PUSH_I32,
	IMPL_OPCODE_PUSH_I64,
	IMPL_OPCODE_PUSH_F32,
	IMPL_OPCODE_PUSH_F64,
	IMPL_OPCODE_PUSH_ATOM,

	IMPL_OPCODE_LOAD,
	IMPL_OPCODE_STORE,

	IMPL_OPCODE_DROP,
	IMPL_OPCODE_DUP,

	IMPL_OPCODE_ADD,
	IMPL_OPCODE_SUB,
	IMPL_OPCODE_MUL,
	IMPL_OPCODE_DIV,

	IMPL_OPCODE_EQUAL,
	IMPL_OPCODE_NOT_EQUAL,

	IMPL_OPCODE_LESS,
	IMPL_OPCODE_LESS_EQUAL,
	IMPL_OPCODE_GREATER,
	IMPL_OPCODE_GREATER_EQUAL,

	IMPL_OPCODE_JUMP,
	IMPL_OPCODE_JUMP_FALSE,
	IMPL_OPCODE_JUMP_TRUE,

	IMPL_OPCODE_REJECT,
	IMPL_OPCODE_REJECT_FALSE,
	IMPL_OPCODE_REJECT_TRUE,
	IMPL_OPCODE_MATCH,

	IMPL_OPCODE_BEGIN_YIELD,
	IMPL_OPCODE_YIELD,
	IMPL_OPCODE_END,

	IMPL_OPCODE_ENUM_START = IMPL_OPCODE_PUSH_U8,
	IMPL_OPCODE_ENUM_END = IMPL_OPCODE_END,

	IMPL_OPCODE_ENUM_MAX,
	IMPL_OPCODE_ENUM_FORCE32 = 0x7FFFFFFF,
} Impl_Opcode;

typedef struct Impl_InstructionDataAddress_t
{
	uint32_t table;
	uint32_t index;
} Impl_InstructionDataAddress;

typedef union Impl_InstructionData_t
{
	uint8_t u8;
	uint16_t u16;
	uint32_t u32;
	uint64_t u64;
	int8_t i8;
	int16_t i16;
	int32_t i32;
	int64_t i64;
	float f32;
	double f64;
	Empathy_Atom atom;
	Impl_InstructionDataAddress address;
} Impl_InstructionData;

typedef struct Impl_Instruction_t
{
	Impl_Opcode opcode;
	Impl_InstructionData data;
} Impl_Instruction;

static uint64_t base_type_sizes[EMPATHY_VALUE_BASE_TYPE_ENUM_MAX] =
{
	// uint / int
	1, 2, 4, 8,
	1, 2, 4, 8,

	// float / double
	4, 8,

	// atom
	8
};

static uint64_t instruction_sizes[IMPL_OPCODE_ENUM_MAX] =
{
	// push
	2, 3, 5, 9,
	2, 3, 5, 9,
	5, 9,
	9,

	// parameters
	9, 9,

	// stack
	1, 1,

	// math
	1, 1, 1, 1,

	// logic
	1, 1,
	1, 1, 1, 1,

	// control
	9, 9, 9,

	// predicates
	1, 1, 1, 1,

	// yield
	1, 5,

	// end
	1,
};

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

		uint64_t instruction_size = instruction_sizes[opcode];
		if (offset + instruction_size > size)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		// TODO: validate atoms, address & yield related opcodes

		offset += instruction_size;
	}

	return EMPATHY_SUCCESS;
}

Empathy_Result impl_bytecodeExecute(Impl_Machine *machine, uint32_t budget, const Impl_Program *program, const Impl_ProgramLayout *layout)
{
	assert(machine);
	assert(machine->execution_stack.data);
	assert(machine->predicate_stack.data);
	assert(program);
	assert(program->data);
	assert(program->size > 0);
	assert(layout);

	const uint8_t *bytes = (const uint8_t *)program->data;

	uint64_t instruction_pointer = machine->instruction_pointer;
	uint32_t current_budget = 0;

	uint64_t size = machine->execution_stack.size;
	Empathy_Value *stack = machine->execution_stack.data;

	while (1)
	{
		if (current_budget >= budget)
			return EMPATHY_EXECUTION_BUDGET_EXCEEDED;

		uint8_t opcode = bytes[instruction_pointer];

		if (opcode < IMPL_OPCODE_ENUM_START || opcode > IMPL_OPCODE_ENUM_END)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		uint64_t instruction_size = instruction_sizes[opcode];
		if (instruction_pointer + instruction_size > program->size)
			return EMPATHY_INVALID_INSTRUCTION_OPCODE;

		uint64_t head = machine->execution_stack.head;
		const uint8_t *instruction_data = bytes + instruction_pointer + 1;

		switch (opcode)
		{
			case IMPL_OPCODE_PUSH_U8:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				uint8_t data = *(const uint8_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT8;
				value.data.u8 = data;

				stack[head++] = value;
			}
			break;
			
			case IMPL_OPCODE_PUSH_U16:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

					uint16_t data = *(const uint16_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT16;
				value.data.u16 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_U32:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				uint32_t data = *(const uint32_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT32;
				value.data.u32 = data;


				stack[head++] = value;

			}
			break;

			case IMPL_OPCODE_PUSH_U64:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				uint64_t data = *(const uint64_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT64;
				value.data.u64 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I8:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				int8_t data = *(const int8_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT8;
				value.data.i8 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I16:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				int16_t data = *(const int16_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT16;
				value.data.i16 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I32:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				int32_t data = *(const int32_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT32;
				value.data.i32 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_I64:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				int64_t data = *(const int64_t *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_INT64;
				value.data.i64 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_F32:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				float data = *(const float *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_FLOAT32;
				value.data.f32 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_F64:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				double data = *(const double *)instruction_data;

				Empathy_Value value = {0};
				value.type.base_type = EMPATHY_VALUE_BASE_TYPE_FLOAT64;
				value.data.f64 = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_PUSH_ATOM:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				Empathy_Atom data = *(const Empathy_Atom *)instruction_data;

				Empathy_Value value = {0};
				value.type = (Empathy_ValueType){EMPATHY_VALUE_BASE_TYPE_ATOM, data.type};
				value.data.atom = data;

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_LOAD:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				Impl_InstructionDataAddress address = *(const Impl_InstructionDataAddress *)instruction_data;

				// TODO: replace this by O(1) hashmap lookup or design better <table; index> mapping to array index
				const Impl_ProgramLayoutParameter *parameter = NULL;
				for (uint64_t i = 0; i < layout->num_parameters; ++i)
				{
					const Impl_ProgramLayoutParameter *src_parameter = &layout->parameters[i];
					if (src_parameter->table != address.table)
						continue;

					if (src_parameter->index != address.index)
						continue;

					parameter = src_parameter;
					break;
				}

				assert(parameter);
				if ((parameter->access & EMPATHY_PARAMETER_ACCESS_FLAGS_READ) == 0)
					return EMPATHY_PARAMETER_NOT_READABLE;

				uint64_t parameter_offset = parameter->offset;
				uint64_t parameter_size = base_type_sizes[parameter->type.base_type];

				assert(address.table < machine->max_bindings);

				const uint8_t *table = (uint8_t *)machine->bindings[address.table].data;
				const uint64_t table_size = machine->bindings[address.table].size;
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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_STORE:
			{
				if (head == 0)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Impl_InstructionDataAddress address = *(const Impl_InstructionDataAddress *)instruction_data;

				// TODO: replace this by O(1) hashmap lookup or design better <table; index> mapping to array index
				const Impl_ProgramLayoutParameter *parameter = NULL;
				for (uint64_t i = 0; i < layout->num_parameters; ++i)
				{
					const Impl_ProgramLayoutParameter *src_parameter = &layout->parameters[i];
					if (src_parameter->table != address.table)
						continue;

					if (src_parameter->index != address.index)
						continue;

					parameter = src_parameter;
					break;
				}
				assert(parameter);

				if ((parameter->access & EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE) == 0)
					return EMPATHY_PARAMETER_NOT_WRITABLE;

				Empathy_Value value = stack[--head];

				if (parameter->type.base_type != value.type.base_type)
					return EMPATHY_BASE_TYPE_MISMATCH;

				if (parameter->type.atom_type != value.type.atom_type)
					return EMPATHY_ATOM_TYPE_MISMATCH;

				uint64_t parameter_offset = parameter->offset;
				uint64_t parameter_size = base_type_sizes[parameter->type.base_type];
				uint64_t value_size = base_type_sizes[value.type.base_type];

				assert(value_size == parameter_size);
				assert(address.table < machine->max_bindings);

				uint8_t *table = (uint8_t *)machine->bindings[address.table].data;
				uint64_t table_size = machine->bindings[address.table].size;
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
			}
			break;

			case IMPL_OPCODE_DROP:
			{
				if (head == 0)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				head--;
			}
			break;

			case IMPL_OPCODE_DUP:
			{
				if (head + 1 == size)
					return EMPATHY_EXECUTION_STACK_OVERFLOW;

				Empathy_Value value = stack[head];
				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_ADD:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_SUB:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_MUL:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_DIV:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_EQUAL:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_NOT_EQUAL:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_LESS:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_LESS_EQUAL:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_GREATER:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_GREATER_EQUAL:
			{
				if (head <= 1)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value b = stack[--head];
				Empathy_Value a = stack[--head];

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

				stack[head++] = value;
			}
			break;

			case IMPL_OPCODE_JUMP:
			{
				instruction_pointer = *(const uint64_t *)instruction_data;
				instruction_size = 0;
			}
			break;

			case IMPL_OPCODE_JUMP_FALSE:
			{
				if (head == 0)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value value = stack[--head];
				if (value.type.base_type != EMPATHY_VALUE_BASE_TYPE_UINT8)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (value.data.u8 == 0)
				{
					instruction_pointer = *(const uint64_t *)instruction_data;
					instruction_size = 0;
				}
			}
			break;

			case IMPL_OPCODE_JUMP_TRUE:
			{
				if (head == 0)
					return EMPATHY_EXECUTION_STACK_UNDERFLOW;

				Empathy_Value value = stack[--head];
				if (value.type.base_type != EMPATHY_VALUE_BASE_TYPE_UINT8)
					return EMPATHY_INVALID_OPERAND_TYPE;

				if (value.data.u8 != 0)
				{
					instruction_pointer = *(const uint64_t *)instruction_data;
					instruction_size = 0;
				}
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
				return EMPATHY_EXECUTION_END;
			}
			break;
		}

		instruction_pointer += instruction_size;
		current_budget++;

		machine->execution_stack.head = head;
		machine->instruction_pointer = instruction_pointer;
	}
}
