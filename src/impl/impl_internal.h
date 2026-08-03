#pragma once

#include "empathy_internal.h"

#include "common/pool.h"

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
	uint32_t index;
	uint32_t table;

	Empathy_ValueType type;
	Empathy_ParameterAccessFlags access;

	uint64_t offset;
} Impl_ProgramLayoutParameter;

typedef struct Impl_ProgramLayoutYield_t
{
	uint32_t index;
	uint64_t num_arguments;
	uint64_t base_argument;
} Impl_ProgramLayoutYield;

typedef struct Impl_ProgramLayout_t
{
	uint64_t num_atom_types;
	Impl_ProgramLayoutAtomType *atom_types;

	uint64_t num_parameters;
	Impl_ProgramLayoutParameter *parameters;

	uint64_t num_yields;
	Impl_ProgramLayoutYield *yields;
	Empathy_ValueType *yield_argument_types;
} Impl_ProgramLayout;

typedef struct Impl_Program_t
{
	Empathy_ProgramLayout layout;
	uint64_t size;
	void *data;
} Impl_Program;

typedef struct Impl_MachineBinding_t
{
	uint64_t size;
	void *data;
} Impl_MachineBinding;

typedef struct Impl_MachineStack_t
{
	Empathy_Value *data;
	uint64_t head;
	uint64_t size;
} Impl_MachineStack;

typedef struct Impl_Machine_t
{
	Empathy_ProgramLayout layout;
	Empathy_Program program;
	Impl_MachineStack execution_stack;
	Impl_MachineStack predicate_stack;
	Impl_MachineBinding *bindings;
	uint64_t max_bindings;
	uint64_t instruction_pointer;
} Impl_Machine;

Empathy_Result impl_bytecodeValidate(uint64_t size, const void *data, const Impl_ProgramLayout *layout);
Empathy_Result impl_bytecodeExecute(Impl_Machine *machine, uint32_t budget, const Impl_Program *program, const Impl_ProgramLayout *layout);
