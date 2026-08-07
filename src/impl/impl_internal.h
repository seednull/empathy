#pragma once

#include "empathy_internal.h"

#include "common/pool.h"

typedef enum Impl_MachineState_t
{
	IMPL_MACHINE_STATE_UNBOUND = 0,
	IMPL_MACHINE_STATE_BOUND,
	IMPL_MACHINE_STATE_RUNNABLE,
	IMPL_MACHINE_STATE_YIELDED,
	IMPL_MACHINE_STATE_ENDED,
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
	uint32_t base_resume_value;
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

typedef struct Impl_MachineCommonState_t
{
	Empathy_ProgramLayout layout;
	Empathy_Program program;

	Impl_MachineBinding *bindings;
	uint32_t max_bindings;
	uint32_t instruction_limit;
} Impl_MachineCommonState;

typedef struct Impl_MachineYieldState_t
{
	Impl_MachineStack stack;
	uint32_t index;
} Impl_MachineYieldState;

typedef struct Impl_MachineExecutionState_t
{
	Impl_MachineStack stack;
	uint64_t instruction_pointer;
} Impl_MachineExecutionState;

typedef struct Impl_MachinePredicateState_t
{
	Impl_MachineStack stack;
} Impl_MachinePredicateState;

typedef struct Impl_Machine_t
{
	Impl_MachineCommonState common;
	Impl_MachineExecutionState execution;
	Impl_MachinePredicateState predicate;
	Impl_MachineYieldState yield;

	Impl_MachineState state;
	Empathy_Result error;
} Impl_Machine;

typedef struct Impl_ExecutionContext_t
{
	const Impl_Program *program;
	const Impl_ProgramLayout *layout;

	Impl_MachineExecutionState execution;
	Impl_MachineYieldState yield;

	Impl_MachineBinding *bindings;
	uint32_t max_bindings;
	Impl_OpcodeMode mode;
} Impl_ExecutionContext;

Empathy_Result impl_bytecodeValidate(const Empathy_ProgramDesc *program_desc, const Impl_ProgramLayout *layout);
Empathy_Result impl_bytecodeExecute(Impl_ExecutionContext *context, uint32_t instruction_limit);
