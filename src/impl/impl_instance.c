#include "impl_internal.h"

#include <assert.h>
#include <string.h>
#include <stdlib.h>

/*
 */
static void impl_destroyProgramLayout(Impl_Instance *instance_ptr, Impl_ProgramLayout *program_layout_ptr)
{
	assert(instance_ptr);
	assert(program_layout_ptr);

	EMPATHY_UNUSED(instance_ptr);

	free(program_layout_ptr->atom_types);
	free(program_layout_ptr->parameters);
	free(program_layout_ptr->yields);
	free(program_layout_ptr->yield_resume_value_types);
};

static void impl_destroyProgram(Impl_Instance *instance_ptr, Impl_Program *program_ptr)
{
	assert(instance_ptr);
	assert(program_ptr);

	EMPATHY_UNUSED(instance_ptr);

	free(program_ptr->data);
	free(program_ptr->entry_points);
}

static void impl_destroyMachine(Impl_Instance *instance_ptr, Impl_Machine *machine_ptr)
{
	assert(instance_ptr);
	assert(machine_ptr);

	EMPATHY_UNUSED(instance_ptr);

	free(machine_ptr->common.bindings);
	free(machine_ptr->execution.stack.data);
	free(machine_ptr->yield.stack.data);
	free(machine_ptr->predicate.stack.data);
}

/*
 */
static Empathy_Result impl_instanceCreateProgramLayout(Empathy_Instance this, const Empathy_ProgramLayoutDesc *desc, Empathy_ProgramLayout *layout)
{
	assert(this);
	assert(desc);
	assert(layout);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;

	Impl_ProgramLayout result = {0};

	if (desc->num_atom_types > 0)
	{
		assert(desc->atom_types);

		result.num_atom_types = desc->num_atom_types;
		result.atom_types = (Impl_ProgramLayoutAtomType *)malloc(sizeof(Impl_ProgramLayoutAtomType) * desc->num_atom_types);

		for (uint64_t i = 0; i < desc->num_atom_types; ++i)
		{
			const Empathy_AtomTypeDesc *src_type = &desc->atom_types[i];
			Impl_ProgramLayoutAtomType *dst_type = &result.atom_types[i];

			dst_type->type = src_type->type;
			dst_type->min_value = src_type->min_value;
			dst_type->max_value = src_type->max_value;
		}
	}

	if (desc->num_parameters > 0)
	{
		assert(desc->parameters);

		result.num_parameters = desc->num_parameters;
		result.parameters = (Impl_ProgramLayoutParameter *)malloc(sizeof(Impl_ProgramLayoutParameter) * desc->num_parameters);

		for (uint64_t i = 0; i < desc->num_parameters; ++i)
		{
			const Empathy_ParameterDesc *src_parameter = &desc->parameters[i];
			Impl_ProgramLayoutParameter *dst_parameter = &result.parameters[i];

			dst_parameter->table = src_parameter->table;
			dst_parameter->type = src_parameter->type;
			dst_parameter->access = src_parameter->access;
			dst_parameter->offset = src_parameter->offset;
		}
	}

	if (desc->num_yields > 0)
	{
		assert(desc->yields);

		uint64_t num_resume_values = 0;
		for (uint64_t i = 0; i < desc->num_yields; ++i)
		{
			const Empathy_YieldDesc *yield = &desc->yields[i];
			num_resume_values += yield->num_resume_values;
		}

		result.num_yields = desc->num_yields;
		result.yields = (Impl_ProgramLayoutYield *)malloc(sizeof(Impl_ProgramLayoutYield) * desc->num_yields);

		result.yield_resume_value_types = (Empathy_ValueType *)malloc(sizeof(Empathy_ValueType) * num_resume_values);

		uint32_t current_argument = 0;
		for (uint32_t i = 0; i < desc->num_yields; ++i)
		{
			const Empathy_YieldDesc *src_yield = &desc->yields[i];
			Impl_ProgramLayoutYield *dst_yield = &result.yields[i];

			dst_yield->num_resume_values = src_yield->num_resume_values;
			dst_yield->base_resume_value = current_argument;

			for (uint32_t j = 0; j < src_yield->num_resume_values; ++j)
				result.yield_resume_value_types[current_argument++] = src_yield->resume_value_types[j];
		}
	}

	*layout = (Empathy_ProgramLayout)empathy_poolAddElement(&instance_ptr->program_layouts, &result);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceCreateProgram(Empathy_Instance this, const Empathy_ProgramDesc *desc, Empathy_Program *program)
{
	assert(this);
	assert(desc);
	assert(desc->data);
	assert(desc->size > 0);
	assert(desc->entry_points);
	assert(desc->num_entry_points > 0);
	assert(program);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElement(&instance_ptr->program_layouts, (Empathy_PoolHandle)desc->layout);
	assert(program_layout_ptr);

	Empathy_Result empathy_result = impl_bytecodeValidate(desc->size, desc->data, program_layout_ptr);
	if (empathy_result != EMPATHY_SUCCESS)
		return empathy_result;

	Impl_Program result = {0};
	result.layout = desc->layout;
	result.size = desc->size;
	result.data = malloc(desc->size);
	result.num_entry_points = desc->num_entry_points;
	result.entry_points = malloc(sizeof(Impl_EntryPoint) * desc->num_entry_points);

	memcpy(result.data, desc->data, desc->size);
	for (uint32_t i = 0; i < desc->num_entry_points; ++i)
	{
		const Empathy_ProgramEntryPointDesc *src_entry = &desc->entry_points[i];
		assert(src_entry->execution_offset < desc->size);
		assert(src_entry->predicate_offset == EMPATHY_PROGRAM_OFFSET_NONE || src_entry->predicate_offset < desc->size);

		Impl_EntryPoint *dst_entry = &result.entry_points[i];

		dst_entry->execution_offset = src_entry->execution_offset;
		dst_entry->predicate_offset = src_entry->predicate_offset;
	}

	*program = (Empathy_Program)empathy_poolAddElement(&instance_ptr->programs, &result);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceCreateMachine(Empathy_Instance this, const Empathy_MachineDesc *desc, Empathy_Machine *machine)
{
	assert(this);
	assert(desc);
	assert(desc->execution_stack_size > 0);
	assert(desc->yield_stack_size > 0);
	assert(desc->predicate_stack_size > 0);
	assert(desc->instruction_limit > 0);
	assert(machine);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;

	Impl_Machine result = {0};
	result.common.instruction_limit = desc->instruction_limit;

	if (desc->max_parameter_tables)
	{
		result.common.max_bindings = desc->max_parameter_tables;
		result.common.bindings = (Impl_MachineBinding *)malloc(sizeof(Impl_MachineBinding) * desc->max_parameter_tables);

		for (uint32_t i = 0; i < desc->max_parameter_tables; ++i)
		{
			result.common.bindings[i].data = NULL;
			result.common.bindings[i].size = 0;
		}
	}


	result.execution.stack.size = desc->execution_stack_size;
	result.execution.stack.data = (Empathy_Value *)malloc(sizeof(Empathy_Value) * desc->execution_stack_size);
	
	result.yield.stack.size = desc->yield_stack_size;
	result.yield.stack.data = (Empathy_Value *)malloc(sizeof(Empathy_Value) * desc->yield_stack_size);

	result.predicate.stack.size = desc->predicate_stack_size;
	result.predicate.stack.data = (Empathy_Value *)malloc(sizeof(Empathy_Value) * desc->predicate_stack_size);
	
	result.state = IMPL_MACHINE_STATE_UNBOUND;

	*machine = (Empathy_Machine)empathy_poolAddElement(&instance_ptr->machines, &result);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroyProgramLayout(Empathy_Instance this, Empathy_ProgramLayout layout)
{
	assert(this);
	assert(layout);

	Empathy_PoolHandle handle = (Empathy_PoolHandle)layout;
	assert(handle != EMPATHY_POOL_HANDLE_NULL);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElement(&instance_ptr->program_layouts, handle);
	assert(program_layout_ptr);

	empathy_poolRemoveElement(&instance_ptr->program_layouts, handle);

	impl_destroyProgramLayout(instance_ptr, program_layout_ptr);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroyProgram(Empathy_Instance this, Empathy_Program program)
{
	assert(this);
	assert(program);

	Empathy_PoolHandle handle = (Empathy_PoolHandle)program;
	assert(handle != EMPATHY_POOL_HANDLE_NULL);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElement(&instance_ptr->programs, handle);
	assert(program_ptr);
	assert(program_ptr->data);
	assert(program_ptr->size > 0);

	empathy_poolRemoveElement(&instance_ptr->programs, handle);

	impl_destroyProgram(instance_ptr, program_ptr);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroyMachine(Empathy_Instance this, Empathy_Machine machine)
{
	assert(this);
	assert(machine);

	Empathy_PoolHandle handle = (Empathy_PoolHandle)machine;
	assert(handle != EMPATHY_POOL_HANDLE_NULL);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElement(&instance_ptr->machines, handle);
	assert(machine_ptr);
	assert(machine_ptr->execution.stack.data);
	assert(machine_ptr->execution.stack.size > 0);
	assert(machine_ptr->predicate.stack.data);
	assert(machine_ptr->predicate.stack.size > 0);

	empathy_poolRemoveElement(&instance_ptr->machines, handle);

	impl_destroyMachine(instance_ptr, machine_ptr);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroy(Empathy_Instance this)
{
	assert(this);

	Impl_Instance *ptr = (Impl_Instance *)this;

	{
		uint32_t head = empathy_poolGetHeadIndex(&ptr->machines);
		while (head != EMPATHY_POOL_HANDLE_NULL)
		{
			Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElementByIndex(&ptr->machines, head);
			impl_destroyMachine(ptr, machine_ptr);

			head = empathy_poolGetNextIndex(&ptr->machines, head);
		}

		empathy_poolShutdown(&ptr->machines);
	}

	{
		uint32_t head = empathy_poolGetHeadIndex(&ptr->programs);
		while (head != EMPATHY_POOL_HANDLE_NULL)
		{
			Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElementByIndex(&ptr->programs, head);
			impl_destroyProgram(ptr, program_ptr);

			head = empathy_poolGetNextIndex(&ptr->programs, head);
		}

		empathy_poolShutdown(&ptr->programs);
	}

	{
		uint32_t head = empathy_poolGetHeadIndex(&ptr->program_layouts);
		while (head != EMPATHY_POOL_HANDLE_NULL)
		{
			Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElementByIndex(&ptr->program_layouts, head);
			impl_destroyProgramLayout(ptr, program_layout_ptr);

			head = empathy_poolGetNextIndex(&ptr->program_layouts, head);
		}

		empathy_poolShutdown(&ptr->program_layouts);
	}

	free(ptr);
	return EMPATHY_SUCCESS;
}

Empathy_Result impl_instanceBindProgram(Empathy_Instance this, Empathy_Machine machine, Empathy_Program program)
{
	assert(this);
	assert(machine);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;

	Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElement(&instance_ptr->programs, (Empathy_PoolHandle)program);
	assert(program_ptr);

	Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElement(&instance_ptr->machines, (Empathy_PoolHandle)machine);
	assert(machine_ptr);

	machine_ptr->common.layout = program_ptr->layout;
	machine_ptr->common.program = program;

	machine_ptr->execution.instruction_pointer = 0;
	machine_ptr->execution.stack.head = 0;

	machine_ptr->yield.index = UINT32_MAX;
	machine_ptr->yield.stack.head = 0;

	machine_ptr->predicate.stack.head = 0;

	machine_ptr->state = IMPL_MACHINE_STATE_BOUND;

	return EMPATHY_SUCCESS;
}

Empathy_Result impl_instanceBindProgramEntryPoint(Empathy_Instance this, Empathy_Machine machine, uint32_t index)
{
	assert(this);
	assert(machine);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElement(&instance_ptr->machines, (Empathy_PoolHandle)machine);
	assert(machine_ptr);
	assert(machine_ptr->execution.stack.data);
	assert(machine_ptr->execution.stack.size > 0);
	assert(machine_ptr->execution.stack.head <= machine_ptr->execution.stack.size);
	assert(machine_ptr->yield.stack.data);
	assert(machine_ptr->yield.stack.size > 0);
	assert(machine_ptr->yield.stack.head <= machine_ptr->yield.stack.size);

	if (machine_ptr->state == IMPL_MACHINE_STATE_UNBOUND)
		return EMPATHY_PROGRAM_NOT_BOUND;

	Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElement(&instance_ptr->program_layouts, (Empathy_PoolHandle)machine_ptr->common.layout);
	assert(program_layout_ptr);

	Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElement(&instance_ptr->programs, (Empathy_PoolHandle)machine_ptr->common.program);
	assert(program_ptr);
	assert(program_ptr->data);
	assert(program_ptr->size);
	assert(program_ptr->layout == machine_ptr->common.layout);
	assert(index < program_ptr->num_entry_points);

	machine_ptr->execution.instruction_pointer = program_ptr->entry_points[index].execution_offset;
	machine_ptr->execution.stack.head = 0;

	machine_ptr->yield.index = UINT32_MAX;
	machine_ptr->yield.stack.head = 0;

	machine_ptr->state = IMPL_MACHINE_STATE_RUNNABLE;

	return EMPATHY_SUCCESS;
}

Empathy_Result impl_instanceBindParameterTable(Empathy_Instance this, Empathy_Machine machine, uint32_t index, uint64_t size, void *data)
{
	assert(this);
	assert(machine);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElement(&instance_ptr->machines, (Empathy_PoolHandle)machine);
	assert(machine_ptr);
	assert(index < machine_ptr->common.max_bindings);

	machine_ptr->common.bindings[index].size = size;
	machine_ptr->common.bindings[index].data = data;

	return EMPATHY_SUCCESS;
}

Empathy_Result impl_instanceRun(Empathy_Instance this, Empathy_Machine machine)
{
	assert(this);
	assert(machine);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElement(&instance_ptr->machines, (Empathy_PoolHandle)machine);
	assert(machine_ptr);
	assert(machine_ptr->execution.stack.data);
	assert(machine_ptr->execution.stack.size > 0);
	assert(machine_ptr->execution.stack.head <= machine_ptr->execution.stack.size);
	assert(machine_ptr->yield.stack.data);
	assert(machine_ptr->yield.stack.size > 0);
	assert(machine_ptr->yield.stack.head <= machine_ptr->yield.stack.size);

	switch (machine_ptr->state)
	{
		case IMPL_MACHINE_STATE_UNBOUND: return EMPATHY_PROGRAM_NOT_BOUND;
		case IMPL_MACHINE_STATE_BOUND: return EMPATHY_PROGRAM_ENTRY_POINT_NOT_BOUND;
		case IMPL_MACHINE_STATE_ENDED: return EMPATHY_EXECUTION_END;
		case IMPL_MACHINE_STATE_FAULTED: return machine_ptr->error;
	}

	Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElement(&instance_ptr->program_layouts, (Empathy_PoolHandle)machine_ptr->common.layout);
	assert(program_layout_ptr);

	Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElement(&instance_ptr->programs, (Empathy_PoolHandle)machine_ptr->common.program);
	assert(program_ptr);
	assert(program_ptr->data);
	assert(program_ptr->size);
	assert(program_ptr->layout == machine_ptr->common.layout);

	if (machine_ptr->state == IMPL_MACHINE_STATE_YIELDED)
	{
		assert(machine_ptr->yield.index < program_layout_ptr->num_yields);

		const Impl_ProgramLayoutYield *yield_desc = &program_layout_ptr->yields[machine_ptr->yield.index];
		const Impl_MachineStack *yield_stack = &machine_ptr->yield.stack;

		if (yield_stack->head < yield_desc->num_resume_values)
			return EMPATHY_INVALID_RESUME_STATE;

		for (uint32_t i = 0; i < yield_desc->num_resume_values; ++i)
		{
			uint32_t index = yield_desc->base_resume_value + i;
			Empathy_ValueType expected_type = program_layout_ptr->yield_resume_value_types[index];

			Empathy_Value value = yield_stack->data[yield_stack->head - yield_desc->num_resume_values + i];

			if (expected_type.base_type != value.type.base_type)
				return EMPATHY_INVALID_RESUME_STATE;

			if (expected_type.atom_type != value.type.atom_type)
				return EMPATHY_INVALID_RESUME_STATE;
		}

		machine_ptr->yield.index = UINT32_MAX;
		machine_ptr->state = IMPL_MACHINE_STATE_RUNNABLE;
	}

	Impl_ExecutionContext context = {0};
	context.program = program_ptr;
	context.layout = program_layout_ptr;
	context.execution = machine_ptr->execution;
	context.yield = machine_ptr->yield;
	context.bindings = machine_ptr->common.bindings;
	context.max_bindings = machine_ptr->common.max_bindings;
	context.mode = IMPL_OPCODE_MODE_EXECUTION;

	Empathy_Result result = impl_bytecodeExecute(&context, machine_ptr->common.instruction_limit);

	machine_ptr->execution = context.execution;
	machine_ptr->yield = context.yield;

	assert(result != EMPATHY_SUCCESS);

	switch (result)
	{
		case EMPATHY_EXECUTION_END: machine_ptr->state = IMPL_MACHINE_STATE_ENDED; break;
		case EMPATHY_EXECUTION_YIELD: machine_ptr->state = IMPL_MACHINE_STATE_YIELDED; break;
		default:
		{
			machine_ptr->state = IMPL_MACHINE_STATE_FAULTED;
			machine_ptr->error = result;
		}
		break;
	}

	return result;
}

/*
 */
static Empathy_InstanceTable instance_vtbl =
{
	impl_instanceCreateProgramLayout,
	impl_instanceCreateProgram,
	impl_instanceCreateMachine,

	impl_instanceDestroyProgramLayout,
	impl_instanceDestroyProgram,
	impl_instanceDestroyMachine,
	impl_instanceDestroy,

	impl_instanceBindProgram,
	impl_instanceBindProgramEntryPoint,
	impl_instanceBindParameterTable,
	impl_instanceRun,
};

/*
 */
Empathy_Result impl_createInstance(const Empathy_InstanceDesc *desc, Empathy_Instance *instance)
{
	assert(desc);
	assert(instance);

	EMPATHY_UNUSED(desc);

	Impl_Instance *ptr = (Impl_Instance *)malloc(sizeof(Impl_Instance));
	assert(ptr);

	// vtable
	ptr->vtbl = &instance_vtbl;

	// data

	// pools
	empathy_poolInitialize(&ptr->program_layouts, sizeof(Impl_ProgramLayout), 32);
	empathy_poolInitialize(&ptr->programs, sizeof(Impl_Program), 32);
	empathy_poolInitialize(&ptr->machines, sizeof(Impl_Machine), 32);

	*instance = (Empathy_Instance)ptr;
	return EMPATHY_SUCCESS;
}
