#include "common.h"

#include <stdio.h>
#include <stdlib.h>

void testCheck(int passed, const char *condition, const char *file, int line)
{
	if (!passed)
	{
		fprintf(stderr, "%s(%d): test check failed: %s\n", file, line, condition);
		abort();
	}
}

void testCreateContext(Test_Context *context)
{
	Empathy_InstanceDesc instance_desc = {0};
	Empathy_Result result = empathyCreateInstance(&instance_desc, &context->instance);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	Empathy_AtomTypeDesc atom_type = {7, 0, 100};
	Empathy_ParameterDesc parameters[] =
	{
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT8, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, u8)},
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT16, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, u16)},
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, u32)},
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT64, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, u64)},
		{0, {EMPATHY_VALUE_BASE_TYPE_INT8, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, i8)},
		{0, {EMPATHY_VALUE_BASE_TYPE_INT16, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, i16)},
		{0, {EMPATHY_VALUE_BASE_TYPE_INT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, i32)},
		{0, {EMPATHY_VALUE_BASE_TYPE_INT64, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, i64)},
		{0, {EMPATHY_VALUE_BASE_TYPE_FLOAT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, f32)},
		{0, {EMPATHY_VALUE_BASE_TYPE_FLOAT64, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, f64)},
		{0, {EMPATHY_VALUE_BASE_TYPE_ATOM, 7}, EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE, offsetof(Test_Values, atom)},
	};
	Empathy_YieldDesc yield = {0, NULL};
	Empathy_ProgramLayoutDesc layout_desc =
	{
		1, &atom_type,
		11, parameters,
		1, &yield,
	};

	result = empathyCreateProgramLayout(context->instance, &layout_desc, &context->layout);
	TEST_CHECK(result == EMPATHY_SUCCESS);
}

void testDestroyContext(Test_Context *context)
{
	Empathy_Result result = empathyDestroyProgramLayout(context->instance, context->layout);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	result = empathyDestroyInstance(context->instance);
	TEST_CHECK(result == EMPATHY_SUCCESS);
}

void testExecuteBytecode(Test_Context *context, const uint8_t *payload, uint64_t payload_size, Test_Values *values)
{
	Empathy_EntryPointDesc entry = {0, EMPATHY_PROGRAM_OFFSET_NONE};
	Empathy_ProgramDesc program_desc =
	{
		context->layout,
		1, &entry,
		EMPATHY_BYTECODE_VERSION, payload_size, payload,
	};

	Empathy_Program program = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgram(context->instance, &program_desc, &program);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	Empathy_MachineDesc machine_desc = {8, 1, 1, 1, 128};
	Empathy_Machine machine = EMPATHY_NULL_HANDLE;
	result = empathyCreateMachine(context->instance, &machine_desc, &machine);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	result = empathyBindProgram(context->instance, machine, program);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	result = empathyBindProgramEntryPoint(context->instance, machine, 0);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	result = empathyBindParameterTable(context->instance, machine, 0, sizeof(*values), values);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	result = empathyRun(context->instance, machine);
	TEST_CHECK(result == EMPATHY_EXECUTION_END);

	result = empathyDestroyMachine(context->instance, machine);
	TEST_CHECK(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgram(context->instance, program);
	TEST_CHECK(result == EMPATHY_SUCCESS);
}
