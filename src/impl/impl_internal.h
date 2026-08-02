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

typedef struct Impl_ProgramLayoutParameter_t
{
	uint64_t index;
	uint64_t binding;

	Empathy_ValueType type;
	Empathy_ParameterAccessFlags access;

	uint64_t offset;
} Impl_ProgramLayoutParameter;

typedef struct Impl_ProgramLayoutCommand_t
{
	uint64_t index;

	uint64_t num_arguments;
	uint64_t base_argument;

	Empathy_ValueType result_type;

} Impl_ProgramLayoutCommand;

typedef struct Impl_ProgramLayout_t
{
	uint64_t num_parameters;
	Impl_ProgramLayoutParameter *parameters;

	uint64_t num_commands;
	Impl_ProgramLayoutCommand *commands;
	Empathy_ValueType *command_argument_types;
} Impl_ProgramLayout;

typedef struct Impl_Program_t
{
	Empathy_ProgramLayout layout;
	uint64_t size;
	void *data;
} Impl_Program;

typedef struct Impl_MachineBinding_t
{
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
	Empathy_Program program;
	Impl_MachineStack execution_stack;
	Impl_MachineStack predicate_stack;
	Impl_MachineBinding *bindings;
	uint64_t max_bindings;
	uint64_t instruction_pointer;
} Impl_Machine;
