#pragma once

#include "empathy_internal.h"

#include "common/pool.h"

typedef enum Impl_MachineState_t
{
	IMPL_MACHINE_STATE_UNBOUND = 0,
	IMPL_MACHINE_STATE_BOUND,
	IMPL_MACHINE_STATE_RUNNABLE,
	IMPL_MACHINE_STATE_YIELDED,
	IMPL_MACHINE_STATE_STOPPED,
	IMPL_MACHINE_STATE_FAULTED,

	IMPL_MACHINE_STATE_ENUM_MAX,
	IMPL_MACHINE_STATE_ENUM_FORCE32 = 0x7FFFFFFF,
} Impl_MachineState;

typedef enum Impl_OpcodeMode_t
{
	IMPL_OPCODE_MODE_EXECUTION = 0x00000001,
	IMPL_OPCODE_MODE_PREDICATE = 0x00000002,
	IMPL_OPCODE_MODE_BOTH = 0x00000003,

	IMPL_OPCODE_MODE_ENUM_FORCE32 = 0x7FFFFFFF,
} Impl_OpcodeMode;

typedef enum Impl_Opcode_t
{
	// constant
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

	// parameter
	IMPL_OPCODE_LOAD,
	IMPL_OPCODE_STORE,

	// stack
	IMPL_OPCODE_DROP,
	IMPL_OPCODE_DUP,

	// arithmetic
	IMPL_OPCODE_ADD,
	IMPL_OPCODE_SUB,
	IMPL_OPCODE_MUL,
	IMPL_OPCODE_DIV,

	// logic
	IMPL_OPCODE_EQUAL,
	IMPL_OPCODE_NOT_EQUAL,
	IMPL_OPCODE_LESS,
	IMPL_OPCODE_LESS_EQUAL,
	IMPL_OPCODE_GREATER,
	IMPL_OPCODE_GREATER_EQUAL,

	// control
	IMPL_OPCODE_JUMP,
	IMPL_OPCODE_JUMP_FALSE,
	IMPL_OPCODE_JUMP_TRUE,

	// predicate
	IMPL_OPCODE_REJECT,
	IMPL_OPCODE_REJECT_FALSE,
	IMPL_OPCODE_REJECT_TRUE,
	IMPL_OPCODE_MATCH,

	// yield
	IMPL_OPCODE_BEGIN_YIELD,
	IMPL_OPCODE_YIELD,

	// end
	IMPL_OPCODE_END,

	IMPL_OPCODE_ENUM_START = IMPL_OPCODE_PUSH_U8,
	IMPL_OPCODE_ENUM_END = IMPL_OPCODE_END,

	IMPL_OPCODE_ENUM_MAX,
	IMPL_OPCODE_ENUM_FORCE32 = 0x7FFFFFFF,
} Impl_Opcode;

typedef struct Impl_Instance_t
{
	Empathy_InstanceTable *vtbl;
	Empathy_Pool program_layouts;
	Empathy_Pool programs;
	Empathy_Pool machines;
} Impl_Instance;

typedef struct Impl_ProgramLayoutAtomType_t
{
	uint32_t type;
	uint32_t min_value;
	uint32_t max_value;
} Impl_ProgramLayoutAtomType;

typedef struct Impl_ProgramLayoutParameter_t
{
	uint32_t table;

	Empathy_ValueType type;
	Empathy_ParameterAccessFlags access;

	uint64_t offset;
} Impl_ProgramLayoutParameter;

typedef struct Impl_ProgramLayoutYield_t
{
	uint32_t num_resume_values;
	uint64_t base_resume_value;
} Impl_ProgramLayoutYield;

typedef struct Impl_ProgramLayout_t
{
	uint32_t num_atom_types;
	Impl_ProgramLayoutAtomType *atom_types;

	uint32_t num_parameters;
	Impl_ProgramLayoutParameter *parameters;

	uint32_t num_yields;
	Impl_ProgramLayoutYield *yields;
	Empathy_ValueType *yield_resume_value_types;
} Impl_ProgramLayout;

typedef struct Impl_EntryPoint_t
{
	uint64_t execution_offset;
	uint64_t predicate_offset;
} Impl_EntryPoint;

typedef struct Impl_Program_t
{
	Empathy_ProgramLayout layout;
	uint64_t size;
	void *data;

	uint32_t num_entry_points;
	Impl_EntryPoint *entry_points;
} Impl_Program;

typedef struct Impl_MachineBinding_t
{
	uint64_t size;
	void *data;
} Impl_MachineBinding;

typedef struct Impl_MachineStack_t
{
	Empathy_Value *data;
	uint32_t head;
	uint32_t size;
} Impl_MachineStack;

typedef struct Impl_Machine_t
{
	Empathy_ProgramLayout layout;
	Empathy_Program program;
	Impl_MachineStack execution_stack;
	Impl_MachineStack predicate_stack;
	Impl_MachineBinding *bindings;
	uint32_t max_bindings;
	uint32_t instruction_limit;
	uint64_t instruction_pointer;
	Impl_MachineState state;
} Impl_Machine;

typedef struct Impl_ExecutionContext_t
{
	const Impl_Program *program;
	const Impl_ProgramLayout *layout;
	Impl_MachineStack stack;
	Impl_MachineBinding *bindings;
	uint64_t instruction_pointer;
	uint32_t max_bindings;
	Impl_OpcodeMode mode;
} Impl_ExecutionContext;

Empathy_Result impl_bytecodeValidate(uint64_t size, const void *data, const Impl_ProgramLayout *layout);
Empathy_Result impl_bytecodeExecute(Impl_ExecutionContext *context, uint32_t instruction_limit);
